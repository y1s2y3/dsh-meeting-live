/**
 * LLM-backed meeting summarizer.
 *
 * The plugin never re-implements a model client: it resolves the current
 * default route from `agentDefaultModel`, prepares one call through `ctx.llm`,
 * and converts the streamed text into the canonical summary shape from
 * `model.js`. A malformed reply gets one repair attempt; both attempts failing
 * raises a Chinese, user-readable error.
 *
 * @module dsh-meeting-live/summarize
 */

import { normalizeSummary, parseSummaryJson } from './model.js'

/** Maximum characters of transcript sent to the model in one request. */
const MAX_TRANSCRIPT_CHARS = 140_000
/** Head/tail split when the transcript exceeds the cap. */
const HEAD_CHARS = 105_000
const TAIL_CHARS = 34_000
/** Hard deadline for one summary attempt. */
const CALL_TIMEOUT_MS = 180_000
/**
 * Output-token cap for one summary attempt.
 *
 * 注意：这是「输出」预算，思考模型的 reasoning token 也算在里面。早期用 8192 时，
 * deepseek-flash 在 2 万字转写上会整整烧掉 8192 个思考 token、正文 0 字，
 * 于是 JSON 永远解析失败（stop_reason=max_tokens）。这里留足余量。
 */
const MAX_TOKENS = 16_384
/** 重试时允许放宽到的输出上限（第一次被截断时用）。 */
const RETRY_MAX_TOKENS = 32_768
/**
 * 纪要/纠错是结构化输出任务，不需要思考：
 * 显式关掉 reasoning，避免输出预算被 reasoning token 吃光（见 MAX_TOKENS 注释）。
 */
const STRUCTURED_REASONING_EFFORT = 'off'
/** 前两次都没拿到合法 JSON 时的兜底指令：要求更精简的 JSON。 */
const COMPACT_FALLBACK_INSTRUCTION = [
  '注意：你前两次的输出都无法被解析为 JSON（可能太长被截断）。',
  '请重新输出一个更精简、但结构完全合法的 JSON 对象：',
  '- overview 控制在 200-350 字；sections 最多 5 段、每段 bullets 最多 3 条；',
  '- keyPoints / decisions / risks / openQuestions / todos 每个数组最多 5 项；',
  '- 不要输出任何解释、代码围栏或多余文字，确保 JSON 能被 JSON.parse 直接解析。',
].join('\n')

/**
 * System instruction: role, output contract, and grounding rules.
 * 结构参考腾讯会议 AI 小助手 / 通义听悟：结论 + 详细概述 + 章节速览（带每章摘要）
 * + 决策依据 + 风险建议 + 待确认问题 + 关键词 + 发言人总结 + 待办。
 * 目标：不是「一句话总结」，而是让没参会的人也能完整理解会议内容。
 */
export const SYSTEM_PROMPT = [
  '你是一位资深的中文会议纪要助理。你会读到一场会议的标题、日期、参会人和完整转写/纪要文本。',
  '你的任务是把内容整理成一份「详细、可读、可执行」的结构化会议纪要 JSON，供渲染成文档并抽取待办。',
  '目标读者是没参加会议的同事：看完纪要要能明白「讨论了什么、为什么这么定、接下来谁做什么」。',
  '',
  '硬性要求：',
  '1. 只输出一个 JSON 对象，不要输出 Markdown 代码围栏、解释、前言或后记。',
  '2. 严格使用下面给出的字段名和类型，不要增删字段、不要改字段名。',
  '3. 只依据提供的文本，不要编造事实、人名、数字或日期；文本没提到的信息留空字符串或空数组。',
  '4. 待办优先提取“有明确交付物 + 有负责人或明确截止时间”的行动项；若讨论明确了下一步要做什么、但没提到谁做或何时做，也要生成待办（owner/due 留空），不要因为信息不全就整场不输出待办。',
  '4.1 转写可能由 5 秒分片拼接而成、有断句和错字，请按语义合并理解，不要因为文本碎片就忽略行动项；todos 通常 3-10 条，确实没有任何行动信息时才给空数组。',
  '5. 相对时间（“下周三”“本周五前”“月底”）必须换算成具体日期：日期用 YYYY-MM-DD，带时刻用 YYYY-MM-DD HH:mm；无法确定就留空字符串。',
  '6. 使用参会文本本身的语言；中文会议就用中文。',
  '',
  '内容深度要求（重要）：整份纪要要覆盖会议从开头到结尾的主要内容，不要只总结前几分钟；overview 不得少于 350 字；信息密度优先，每一句都要有实质信息，不要用“大家进行了深入讨论”这类空话凑长度。文本本身很短时按实际内容写，不要硬编。',
  '',
  '各字段写法：',
  '- suggestedTitle：8-20 个汉字概括会议主题（例如“Q4预算评审与投放排期”），不要用“会议纪要”“讨论”这类空泛词。',
  '- oneLine：一句话结论（不超过 60 个汉字），必须写出这场会最重要、最可执行的决定或结论。',
  '- overview：400-800 字的整体概述，最少 350 字，2-4 段（段落之间用换行符 \\n\\n 分隔）。第一段写会议背景/目的与整体判断；第二段写主要讨论内容与分歧；第三段写达成的结论与下一步。要求读完概述就基本了解会议全貌；如果原文信息偏少或很碎，就把各章节的关键信息汇总进概述，宁可写详细也不要只给一两句，但不得编造。',
  '- keyPoints：6-10 条关键要点，每条 20-60 字，必须带具体信息（谁、什么数字、哪个系统/模块、什么时间），不要同义重复 oneLine。',
  '- decisions：3-10 条已经明确决定的事项。text 写“决定了什么”；rationale 写“为什么这么定 / 影响 / 依据”（文本没提就留空）；owner 写负责人（没提就留空）。',
  '- risks：3-10 条风险或待确认事项。text 写风险本身；level 取 low|medium|high；suggestion 写建议的应对方式（没提就留空）。',
  '- sections：按会议时间/议题顺序输出 4-12 节「章节速览」。heading 用 8-20 字概括该章节议题；summary 用 2-4 句、80-200 字概括这一节讨论了什么、达成什么（不要只重复 bullets）；bullets 输出 3-8 条该节的具体要点，每条 15-60 字，带上数字、人名、系统名等细节。',
  '- keywords：5-15 个关键词（项目名/系统名/产品模块/关键指标/关键决策词），每个不超过 12 字。',
  '- speakerSummaries：仅当文本能区分说话人（例如 S1/S2、A：/B：、姓名：）时输出，每人 60-200 字，写他/她的关注点、立场和承诺；文本无法区分说话人时输出空数组 []。',
  '- openQuestions：3-10 条需要会后确认的问题（事实、数据口径、外部依赖、未定的责任），不要与 risks 重复；没有就输出空数组。',
  '- attendees：从文本中能确认的参会人；识别不出就留空数组，不要编造。',
  '- todos：3-10 条行动项。title 用动词开头的交付物（不超过 40 字）；notes 写验收标准、依赖或上下文（不超过 200 字）；owner/due 没提就留空。',
  '',
  '输出 JSON 形状：',
  '{',
  '  "suggestedTitle": "8-20 字标题",',
  '  "oneLine": "一句话结论（≤60字）",',
  '  "overview": "400-800 字多段概述，段落间用 \\n\\n 分隔",',
  '  "keyPoints": ["关键要点（6-10 条，带细节）"],',
  '  "keywords": ["关键词"],',
  '  "decisions": [{"text": "决定事项", "rationale": "依据/影响，可空", "owner": "负责人或空"}],',
  '  "risks": [{"text": "风险或待确认事项", "level": "low|medium|high", "suggestion": "应对建议，可空"}],',
  '  "sections": [{"heading": "章节议题", "summary": "该章节 2-4 句摘要", "bullets": ["该章节具体要点"]}],',
  '  "speakerSummaries": [{"speaker": "S1 或姓名", "summary": "该发言人观点总结"}],',
  '  "openQuestions": ["需要会后确认的问题"],',
  '  "attendees": ["从文本中能确认的参会人"],',
  '  "todos": [{"title": "交付物", "owner": "负责人或空", "due": "截止时间或空", "priority": "high|normal|low", "notes": "验收标准/依赖/上下文"}]',
  '}',
].join('\n')

/**
 * 单独的「行动项抽取」指令：首次纪要没产出待办时再补一次。
 * 比主 prompt 宽松：没写负责人/截止时间也允许生成，避免整场 0 待办。
 */
export const TODO_EXTRACT_PROMPT = [
  '你是会议行动项抽取器，只输出一个 JSON 对象，不要输出解释、Markdown 或多余文字。',
  '从会议文本里找出「接下来要做的具体事情」：哪怕没提负责人、没提截止时间，也要抽成待办，owner/due 留空即可。',
  '转写可能由分片拼接而成、有断句和错字，请按语义合并理解，不要把同一件事拆成多条。',
  'title 用动词开头的交付物（不超过 40 字）；priority 取 high|normal|low。',
  '只有整场会议确实没有任何行动信息时，才输出空数组。',
  '输出形状：{"todos":[{"title":"交付物","owner":"","due":"","priority":"normal","notes":""}]}',
].join('\n')

/** 行动项抽取的用户消息：会议信息 + 已识别决策/风险 + 转写全文。 */export function buildTodoExtractPrompt(meeting, summary = {}) {
  const decisions = Array.isArray(summary?.decisions) ? summary.decisions.map((item) => (typeof item === 'string' ? item : String(item?.text ?? ''))).filter(Boolean) : []
  const risks = Array.isArray(summary?.risks) ? summary.risks.map((item) => (typeof item === 'string' ? item : String(item?.text ?? ''))).filter(Boolean) : []
  const lines = [
    `会议标题：${meeting?.title ?? ''}`,
    `会议日期：${meeting?.date ?? ''}`,
    `参会人：${Array.isArray(meeting?.attendees) && meeting.attendees.length > 0 ? meeting.attendees.join('、') : '（未提供）'}`,
    decisions.length > 0 ? '已识别的决策事项：\n' + decisions.map((item) => '- ' + item).join('\n') : '',
    risks.length > 0 ? '已识别的风险/待确认事项：\n' + risks.map((item) => '- ' + item).join('\n') : '',
    '',
    '会议文本如下：',
    '----- 会议文本开始 -----',
    clampTranscript(String(meeting?.transcript ?? '')),
    '----- 会议文本结束 -----',
    '',
    '请输出 {"todos": [...]}。',
  ].filter((line) => line !== '')
  return lines.join('\n')
}

/** Keep a long transcript under the request budget without losing the ending. */
export function clampTranscript(text, limit = MAX_TRANSCRIPT_CHARS) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= limit) return value
  const head = value.slice(0, HEAD_CHARS)
  const tail = value.slice(-TAIL_CHARS)
  return `${head}\n\n[……中间省略 ${value.length - HEAD_CHARS - TAIL_CHARS} 字……]\n\n${tail}`
}

/** User message: meeting metadata plus the transcript. */
export function buildUserPrompt(meeting) {
  const transcript = String(meeting?.transcript ?? '')
  // 优先用本地说话人分段的真实标记（A/B/C/D 或 S1/S2）；没有分段时再看转写文本里的标记。
  const segments = Array.isArray(meeting?.transcriptSegments) ? meeting.transcriptSegments : []
  const segmentSpeakers = [...new Set(segments
    .map((item) => String(item?.speaker ?? '').trim())
    .filter((name) => name !== ''))].slice(0, 12)
  const hasSpeakerMarks = segmentSpeakers.length > 0 || /(^|\n)\s*(S\d{1,2}|[A-Za-z]\d?)\s*[：:]/.test(transcript)
  const speakerLine = segmentSpeakers.length > 0
    ? `文本包含说话人标记（${segmentSpeakers.join('、')}）：请为每位说话人输出 speakerSummaries，speaker 字段直接用这些标记。`
    : (hasSpeakerMarks
      ? '文本包含说话人标记（如 S1/S2、A：/B：）：请按说话人分别总结到 speakerSummaries。'
      : '文本没有稳定的说话人标记：speakerSummaries 请输出空数组。')
  const speakerNames = meeting?.speakerNames !== null && typeof meeting?.speakerNames === 'object' ? meeting.speakerNames : {}
  const speakerNamePairs = Object.entries(speakerNames)
    .filter(([, name]) => typeof name === 'string' && name.trim() !== '')
    .map(([speaker, name]) => speaker + '=' + name.trim())
  const lines = [
    `会议标题：${meeting.title}`,
    `会议日期：${meeting.date}`,
    `参会人：${meeting.attendees.length > 0 ? meeting.attendees.join('、') : '（未提供）'}`,
    meeting.notes === '' ? '' : `补充说明：${meeting.notes}`,
    speakerNamePairs.length > 0 ? '说话人对应关系：' + speakerNamePairs.join('、') + '（speakerSummaries 请使用真实姓名）' : '',
    '',
    '会议文本如下（可能是转写稿或腾讯会议纪要原文）：',
    speakerLine,
    '请通读全文、按章节顺序输出，覆盖从会议开始到最后的内容，不要只总结前几段。',
    '----- 会议文本开始 -----',
    clampTranscript(transcript),
    '----- 会议文本结束 -----',
  ].filter((line) => line !== '')
  return lines.join('\n')
}

/** 不同会议类型的纪要侧重（用户可在设置里选）。 */
export const TEMPLATE_INSTRUCTIONS = {
  general: '按通用会议纪要写：结论、讨论、决策、风险、待办均衡覆盖。',
  review: '这是评审会：重点写清评审对象、通过/不通过/有条件通过的结论、需要修改的具体项与责任人。',
  weekly: '这是周会/例会：重点写本周进展、未完成事项、下周计划、需要协调的风险。',
  client: '这是客户/外部会议：重点写客户需求与关注点、我方承诺、待客户确认事项；措辞正式、避免内部黑话。',
  retro: '这是复盘会：重点写发生了什么、原因分析、经验教训、改进项与跟进人，不要只罗列结论。',
}

/** 把会议模板转成 prompt 追加指令；未知模板回退通用。 */
export function templateInstruction(template) {
  return TEMPLATE_INSTRUCTIONS[template] ?? TEMPLATE_INSTRUCTIONS.general
}

/** 「周报汇总」的 system 指令：把一段时间内的会议纪要汇总成 Markdown 周报。 */
export const DIGEST_PROMPT = [
  '你是项目经理的会议汇总助手。你会读到一段时间内的多场会议纪要（标题、日期、结论、决策、风险、待办）。',
  '请把这些会议汇总成一份中文 Markdown 周报，供发给团队或上级。',
  '',
  '结构要求（用 Markdown 标题）：',
  '## 本周概览',
  '3-6 句话概括这段时间的会议主线、关键结论与整体进展。',
  '## 关键结论',
  '按项目/主题分组列要点，每条一句话，尽量带会议标题或日期便于追溯。',
  '## 待办进展',
  '汇总各会议的待办：已完成/进行中/未开始（根据是否已写入 DSH 待办判断进度），标注负责人与截止日期。',
  '## 风险与卡点',
  '汇总各会议提到的风险、未决问题、需要协调的事项，按严重程度排序。',
  '## 下周建议',
  '3-5 条具体建议：优先处理什么、需要谁拍板、哪些会议可以合并/取消。',
  '',
  '硬性要求：',
  '1. 只依据提供的会议纪要，不要编造会议或结论；没有的信息不要写。',
  '2. 待办/负责人/截止日期原样引用，不要改人名和日期。',
  '3. 总长度控制在 800-1500 字，信息密度优先。',
  '4. 只输出 Markdown 正文，不要代码围栏、不要解释。',
].join('\n')

/** 周报的用户消息：把每场会议压成结构化摘要后交给模型。 */
export function buildDigestUserPrompt(meetings, rangeLabel = '') {
  const lines = []
  if (rangeLabel !== '') lines.push('时间范围：' + rangeLabel)
  for (const meeting of Array.isArray(meetings) ? meetings : []) {
    const summary = meeting?.summary ?? {}
    const decisions = (Array.isArray(summary.decisions) ? summary.decisions : []).map((item) => (typeof item === 'string' ? item : String(item?.text ?? ''))).filter((item) => item !== '')
    const risks = (Array.isArray(summary.risks) ? summary.risks : []).map((item) => (typeof item === 'string' ? item : String(item?.text ?? ''))).filter((item) => item !== '')
    const todos = (Array.isArray(summary.todos) ? summary.todos : []).map((todo) => {
      const state = todo?.calendarTaskId ? '已写入待办' : '未写入待办'
      return '· ' + String(todo?.title ?? '') + (todo?.owner ? '（' + todo.owner + '）' : '') + (todo?.due ? ' 截止 ' + todo.due : '') + ' [' + state + ']'
    })
    lines.push(
      '===== ' + String(meeting?.title ?? '未命名会议') + '（' + String(meeting?.date ?? '') + '） =====',
      '一句话结论：' + String(summary.oneLine ?? ''),
      decisions.length > 0 ? '决策：' + decisions.join('；') : '',
      risks.length > 0 ? '风险：' + risks.join('；') : '',
      todos.length > 0 ? '待办：\n' + todos.join('\n') : '',
      '',
    )
  }
  return lines.filter((line) => line !== undefined).join('\n')
}

/**
 * 「从文件夹提取术语」的 system 指令：只输出排好序的术语 JSON。
 * 目标是给转写纠错用的术语表（专有名词/人名/系统名），不是会议摘要。
 */
export const TERM_EXTRACT_PROMPT = [
  '你是会议转写纠错的「术语库整理助手」。你会读到从用户文件夹里汇总的文本（可能是多份会议纪要、转写稿或方案文档）。',
  '任务：从文本里抽取对「转写纠错」最有价值的专有名词，按重要性排序，最多 50 个。',
  '',
  '只输出一个 JSON 对象，不要输出 Markdown 代码围栏、解释或前言：',
  '{"terms":[{"text":"术语","category":"术语","priority":1,"evidence":"一句话说明它是什么","count":3}]}',
  '',
  '硬性要求：',
  '1. 只抽文本中真实出现的专有名词；category 只能取：术语、产品/系统、项目、机构、人名、其他。',
  '2. 优先级从高到低：行业/业务/技术术语、产品与系统名、项目名、机构名、真实人名；不要抽“会议、项目、需求、问题、时间、工作、方案、系统、功能”这类通用词。',
  '3. 人名只抽真实姓名（2-4 个汉字，且文本中出现过至少 2 次或带职务/称呼佐证）；不要把“张总、李工、王经理”这类称呼本身当成人名。',
  '4. priority 从 1 开始连续编号，1 最重要（越容易写错、越核心、出现越多越靠前）；最多 50 个，内容不够就少给，不要凑数。',
  '5. text 不超过 20 个字；evidence 不超过 30 个字（它是什么，可带出现文件）；count 给出现次数（估计值，至少 1）。',
  '6. 同一个概念只保留一种写法（用文本里最常见、最规范的写法）；英文缩写与全称都常见时可保留缩写。',
  '7. 纯文本里没有的专有名词不要编造；不确定是不是专有名词的通用短语不要输出。',
].join('\n')

/** 术语提取的用户消息：文件统计 + 汇总文本。 */
export function buildTermUserPrompt(source, stats = {}) {
  const text = typeof source === 'string' ? source : ''
  const files = Number(stats?.supported ?? 0)
  const chars = Number(stats?.chars ?? text.length)
  const names = Array.isArray(stats?.names) ? stats.names.slice(0, 20) : []
  const lines = [
    `已读取 ${files} 个文件，共约 ${chars} 个字。`,
    names.length > 0 ? '文件列表：' + names.join('、') : '',
    stats?.truncated === true ? '（文件较多或较长，以下只是部分内容）' : '',
    '',
    '需要提取术语的文本如下：',
    '----- 文本开始 -----',
    text,
    '----- 文本结束 -----',
    '',
    '请只输出 JSON：最多 50 个专有名词，priority 从 1 开始按重要性排序。',
  ].filter((line) => line !== '')
  return lines.join('\n')
}

/** Repair prompt used when the first reply is not a parseable JSON object. */
export function buildRepairPrompt(previousText, meeting) {
  const excerpt = typeof previousText === 'string' ? previousText.slice(0, 6000) : ''
  return [
    buildUserPrompt(meeting),
    '',
    '你上一次的输出无法被解析为 JSON。上一次输出如下（可能被截断）：',
    '----- 上一次输出开始 -----',
    excerpt,
    '----- 上一次输出结束 -----',
    '',
    '请重新输出：只输出一个 JSON 对象，字段与类型必须完全符合要求，不要代码围栏或任何解释。',
  ].join('\n')
}

/**
 * 把内部消息形状（content 为 block 数组）压平成 OpenAI 兼容接口要的字符串。
 * @param messages - `[{ role, content: [{ type:'text', text }] }]`。
 */
function flattenMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    const content = Array.isArray(message?.content)
      ? message.content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('')
      : String(message?.content ?? '')
    return { role: message?.role === 'assistant' ? 'assistant' : 'user', content }
  })
}

/**
 * 调用用户在设置里手动配置的 OpenAI 兼容接口（/chat/completions）。
 *
 * 与 DSH 路由的区别：这里不走 `ctx.llm`，直接用本机 fetch 发 HTTP 请求；
 * 只做一次性（非流式）调用，返回完整的纪要文本。
 *
 * @param messages - 对话消息（内部 block 形状）。
 * @param system - system 指令。
 * @param custom - `{ baseUrl, apiKey, model, temperature, maxTokens }`。
 * @param signal - 可选的 AbortSignal。
 * @returns `{ text, route: { provider: 'custom', model } }`。
 */
async function callCustomModel(messages, system, custom, signal) {
  const baseUrl = String(custom?.baseUrl ?? '').trim().replace(/\/+$/, '')
  const model = String(custom?.model ?? '').trim()
  if (baseUrl === '' || model === '') {
    throw new Error('手动配置总结模型需要填写接口地址与模型名（API Key 视服务是否必需）')
  }
  const url = /\/chat\/completions$/.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`
  const apiKey = String(custom?.apiKey ?? '').trim()
  const temperature = Number(custom?.temperature)
  const maxTokens = Number(custom?.maxTokens)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('总结超时')), CALL_TIMEOUT_MS)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey === '' ? {} : { authorization: 'Bearer ' + apiKey }),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: String(system ?? '') }, ...flattenMessages(messages)],
        temperature: Number.isFinite(temperature) ? temperature : 0.3,
        max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.round(maxTokens) : MAX_TOKENS,
        stream: false,
      }),
      signal: controller.signal,
    })
    const raw = await response.text()
    let payload = null
    try {
      payload = raw === '' ? null : JSON.parse(raw)
    } catch {
      payload = null
    }
    if (!response.ok) {
      const message = payload?.error?.message ?? payload?.message ?? (raw.slice(0, 300) || '')
      throw new Error('总结接口返回 ' + String(response.status) + (message === '' ? '' : '：' + String(message)))
    }
    const content = payload?.choices?.[0]?.message?.content
    const text = Array.isArray(content)
      ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
      : (typeof content === 'string' ? content : '')
    if (text.trim() === '') throw new Error('总结接口没有返回内容（检查模型名与接口是否兼容 OpenAI Chat Completions）')
    return { text, route: { provider: 'custom', model } }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('总结已取消：调用被中断')
    if (error instanceof TypeError) throw new Error('连不上总结接口：' + String(error.message))
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/** One assistant reply assembled from the streamed chunks. */
async function collectStream(stream) {
  let text = ''
  let finish = null
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta') text += chunk.text
    else if (chunk?.type === 'finish') finish = chunk.reason ?? null
  }
  if (finish !== null && finish.kind === 'error') {
    throw new Error(`总结失败：${finish.failure?.message ?? '模型返回错误'}`)
  }
  if (finish !== null && finish.kind === 'aborted') {
    throw new Error(`总结已取消：${finish.failure?.message ?? '调用被中断'}`)
  }
  return { text, finish }
}

/** Resolve the model route: explicit options, then the agent default model. */
export function resolveRoute(ctx, options = {}) {
  const selection = options.selection ?? ctx.get?.('agentDefaultModel')?.currentSelection?.()
  if (selection === null || selection === undefined || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
    throw new Error('没有可用的默认模型：请先在模型设置里选择一个模型，再生成会议纪要。')
  }
  return { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort }
}

/**
 * Create the summarizer.
 * @param options - `ctx` (host Cordis context), `logger` (optional).
 */
export function createSummarizer(options) {
  const ctx = options.ctx
  const logger = options.logger

  /**
   * Run one model call and return the raw text.
   * @param messages - request messages.
   * @param system - system instruction.
   * @param signal - optional AbortSignal.
   * @param selection - optional explicit provider/model selection.
   * @param callOptions - optional `{ maxTokens, reasoningEffort }` overrides.
   */
  async function callModel(messages, system, signal, selection, callOptions = {}) {
    const llm = ctx.get?.('llm')
    if (llm === undefined || llm === null) {
      throw new Error('本机没有可用的模型服务（llm），无法生成会议纪要。')
    }
    const route = resolveRoute(ctx, selection === null || selection === undefined ? {} : { selection })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('总结超时')), CALL_TIMEOUT_MS)
    const onAbort = () => controller.abort(signal.reason)
    if (signal !== undefined) {
      if (signal.aborted) controller.abort(signal.reason)
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const requestedMaxTokens = Number(callOptions?.maxTokens)
    const maxTokens = Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
      ? Math.round(requestedMaxTokens)
      : MAX_TOKENS
    const reasoningEffort = callOptions?.reasoningEffort === undefined
      ? STRUCTURED_REASONING_EFFORT
      : callOptions.reasoningEffort
    const run = async (config) => {
      const call = await llm.prepareCall(config, controller.signal)
      const streamOptions = {
        ...call.config,
        messages,
        system,
        signal: controller.signal,
      }
      return collectStream(call.stream(streamOptions))
    }
    // 逐级降级：显式关思考 → 只带 maxTokens → 全用适配器默认。
    // 只在「能力不支持」类错误上降级；网络/超时等错误直接抛出，避免重复跑三次。
    const candidates = [
      { provider: route.provider, model: route.model, maxTokens, reasoningEffort },
      { provider: route.provider, model: route.model, maxTokens },
      { provider: route.provider, model: route.model },
    ]
    let lastError = null
    try {
      for (const candidate of candidates) {
        try {
          const result = await run(candidate)
          return { text: result.text, finish: result.finish ?? null, route }
        } catch (error) {
          lastError = error
          const message = String(error?.message ?? '')
          const capabilityError = /max.?tokens|output|reasoning|effort|thinking|unsupported|不支持/i.test(message)
          if (!capabilityError) throw error
        }
      }
      throw lastError ?? new Error('模型调用失败')
    } finally {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * 首次纪要没有待办时，再做一次「只抽行动项」的补抽。
   * 安静/碎片化转写容易让主 prompt 判定“没有明确交付物”而整场 0 待办。
   */
  async function ensureTodos(parsed, meeting, callModelFn) {
    const existing = Array.isArray(parsed?.todos)
      ? parsed.todos.filter((item) => item && typeof item === 'object' && String(item.title ?? '').trim() !== '')
      : []
    if (existing.length > 0) return parsed
    const transcript = typeof meeting?.transcript === 'string' ? meeting.transcript.trim() : ''
    if (transcript.length < 80) return parsed
    try {
      const messages = [{ role: 'user', content: [{ type: 'text', text: buildTodoExtractPrompt(meeting, parsed) }] }]
      const result = await callModelFn(messages, TODO_EXTRACT_PROMPT)
      const extra = parseSummaryJson(result.text)
      const todos = Array.isArray(extra?.todos) ? extra.todos : []
      if (todos.length === 0) return parsed
      logger?.info?.(`meeting-minutes: todo fallback extracted ${todos.length} item(s)`)
      return { ...parsed, todos }
    } catch (error) {
      logger?.warn?.(`meeting-minutes: todo fallback failed: ${error instanceof Error ? error.message : String(error)}`)
      return parsed
    }
  }

  /**
   * 从文件夹汇总文本里提取术语（供转写纠错用）。
   * @param source - 汇总后的文本。
   * @param stats - `{ supported, chars, names, truncated }`。
   * @param options - `{ custom, selection, signal }`。
   * @returns `{ items }`（原始条目，由调用方 normalizeTermItems 归一化）。
   */
  async function extractTerms(source, stats = {}, options = {}) {
    const text = typeof source === 'string' ? source.trim() : ''
    if (text === '') throw new Error('文件夹里没有可解析的文本内容')
    const custom = options.custom ?? null
    const signal = options.signal
    const callModelFn = async (messages, system) => {
      if (custom !== null) return callCustomModel(messages, system, custom, signal)
      return callModel(messages, system, signal, options.selection ?? null)
    }
    const messages = [{ role: 'user', content: [{ type: 'text', text: buildTermUserPrompt(text, stats) }] }]
    const first = await callModelFn(messages, TERM_EXTRACT_PROMPT)
    let parsed = parseSummaryJson(first.text)
    if (parsed === null) {
      logger?.warn?.('meeting-minutes: term extract returned non-JSON, retrying once')
      const retry = await callModelFn(messages, TERM_EXTRACT_PROMPT + '\n\n注意：上一次输出无法解析为 JSON。请只输出一个 JSON 对象，不要代码围栏或解释。')
      parsed = parseSummaryJson(retry.text)
    }
    if (parsed === null) throw new Error('模型没有返回可解析的术语 JSON，请稍后重试')
    const items = Array.isArray(parsed.terms) ? parsed.terms : (Array.isArray(parsed.items) ? parsed.items : [])
    return { items }
  }

  /**
   * Summarize one meeting.
   * @param meeting - canonical meeting with non-empty transcript.
   * @param options - `signal` (AbortSignal).
   * @returns canonical summary.
   */
  async function summarize(meeting, options = {}) {
    if (typeof meeting?.transcript !== 'string' || meeting.transcript.trim() === '') {
      throw new Error('这场会议还没有文本内容：请先录音转写，或导入腾讯会议纪要文本。')
    }
    const signal = options.signal
    const custom = options.custom ?? null
    const callModelFn = async (messages, system, callOptions = {}) => {
      if (custom !== null) return callCustomModel(messages, system, custom, signal)
      return callModel(messages, system, signal, options.selection ?? null, callOptions)
    }
    const messages = [{ role: 'user', content: [{ type: 'text', text: buildUserPrompt(meeting) }] }]
    const system = SYSTEM_PROMPT + '\n\n' + templateInstruction(options.template)
    const first = await callModelFn(messages, system)
    const parsed = parseSummaryJson(first.text)
    if (parsed !== null) {
      const withTodos = await ensureTodos(parsed, meeting, callModelFn)
      return normalizeSummary(withTodos, {
        previous: meeting.summary,
        now: new Date(),
        model: `${first.route.provider}/${first.route.model}`,
      })
    }
    const truncated = first.finish !== null && first.finish !== undefined && first.finish.kind === 'max-tokens'
    logger?.warn?.(`meeting-minutes: first summary reply was not JSON (${String(first.text ?? '').length} chars`
      + `${truncated ? ', stopped by max-tokens' : ''}); retrying once with a larger output budget`)
    const repairMessages = [{
      role: 'user',
      content: [{ type: 'text', text: buildRepairPrompt(first.text, meeting) }],
    }]
    const second = await callModelFn(repairMessages, SYSTEM_PROMPT, { maxTokens: RETRY_MAX_TOKENS })
    let repaired = parseSummaryJson(second.text)
    let used = second
    if (repaired === null) {
      // 前两次都拿不到合法 JSON：用「更精简」的兜底指令再来一次，长会议容易把 JSON 写到被截断。
      logger?.warn?.('meeting-minutes: repair reply was still not JSON; trying a compact fallback prompt')
      const compact = await callModelFn(messages, SYSTEM_PROMPT + '\n\n' + COMPACT_FALLBACK_INSTRUCTION, { maxTokens: RETRY_MAX_TOKENS })
      repaired = parseSummaryJson(compact.text)
      used = compact
    }
    if (repaired === null) {
      throw new Error('模型返回的纪要格式无法解析（已自动重试 2 次）。可再点一次「重新生成纪要」；若持续失败，请在设置里换一个模型或用「手动配置总结模型」。')
    }
    const repairedWithTodos = await ensureTodos(repaired, meeting, callModelFn)
    return normalizeSummary(repairedWithTodos, {
      previous: meeting.summary,
      now: new Date(),
      model: `${used.route.provider}/${used.route.model}`,
    })
  }

  /**
   * 用 LLM 对转写做一次"只改错别字/术语/人名"的纠错。
   * 失败时抛错，调用方保留原文。
   */
  async function correctTranscript(meeting, options = {}) {
    const raw = typeof meeting?.transcript === 'string' ? meeting.transcript : ''
    if (raw.trim() === '') throw new Error('没有可纠错的转写文本')
    const custom = options.custom ?? null
    const terms = Array.isArray(options.terms) ? options.terms : []
    const context = typeof options.context === 'string' ? options.context.trim() : ''
    const instruction = [
      '你是中文会议转写的校对员。请只修正错别字、同音字、专有名词（术语/系统名/人名）与明显断词，',
      '不要改写句式、不要删减内容、不要总结、不要添加原文没有的信息。',
      '保持原有的换行与说话人标记（如 S1：、A：）不变。',
      '如果原文没有标点（Paraformer 输出通常无标点），请补全逗号、句号、问号等标点并合理断句。',
      terms.length > 0 ? '优先使用这些术语的正确写法：' + terms.join('、') : '',
      context !== '' ? '这些是相关历史会议的结论，仅用于帮助判断专有名词与同音词，不要照抄其内容：\n' + context : '',
      '只输出校对后的全文，不要解释。',
    ].filter((line) => line !== '').join('\n')
    const messages = [{ role: 'user', content: [{ type: 'text', text: buildUserPrompt({ ...meeting, transcript: raw }) }] }]
    const result = custom !== null
      ? await callCustomModel(messages, instruction, custom, options.signal)
      : await callModel(messages, instruction, options.signal, options.selection ?? null)
    const text = String(result?.text ?? '').trim()
    if (text === '') throw new Error('纠错模型没有返回内容')
    const ratio = text.length / Math.max(1, raw.length)
    if (ratio < 0.7 || ratio > 1.3) throw new Error('纠错结果长度异常（' + ratio.toFixed(2) + ' 倍），已保留原文')
    return text
  }

  /**
   * 只重新生成待办（不动纪要其它字段）。
   * @param meeting - canonical meeting with transcript.
   * @param options - `selection` / `custom` / `signal`。
   * @returns 模型给出的待办原始数组（未分配 id）。
   */
  async function extractTodos(meeting, options = {}) {
    const signal = options.signal
    const custom = options.custom ?? null
    const callModelFn = async (messages, system) => {
      if (custom !== null) return callCustomModel(messages, system, custom, signal)
      return callModel(messages, system, signal, options.selection ?? null)
    }
    const transcript = typeof meeting?.transcript === 'string' ? meeting.transcript.trim() : ''
    if (transcript === '') throw new Error('这场会议还没有文本内容，无法重新生成待办。')
    const messages = [{
      role: 'user',
      content: [{ type: 'text', text: buildTodoExtractPrompt(meeting, meeting.summary ?? {}) }],
    }]
    const result = await callModelFn(messages, TODO_EXTRACT_PROMPT)
    const parsed = parseSummaryJson(result.text)
    const todos = Array.isArray(parsed?.todos) ? parsed.todos : []
    logger?.info?.(`meeting-minutes: extracted ${todos.length} replacement todo(s)`)
    return todos
  }

  /** 把一段时间内的多场会议汇总成 Markdown 周报。 */
  async function generateDigest(meetings, options = {}) {
    const list = Array.isArray(meetings) ? meetings : []
    if (list.length === 0) throw new Error('所选时间范围内没有可汇总的会议')
    const custom = options.custom ?? null
    const signal = options.signal
    const callModelFn = async (messages, system) => {
      if (custom !== null) return callCustomModel(messages, system, custom, signal)
      return callModel(messages, system, signal, options.selection ?? null)
    }
    const messages = [{ role: 'user', content: [{ type: 'text', text: buildDigestUserPrompt(list, String(options.rangeLabel ?? '')) }] }]
    const result = await callModelFn(messages, DIGEST_PROMPT)
    const markdown = String(result?.text ?? '').trim()
    if (markdown === '') throw new Error('周报模型没有返回内容')
    return { markdown, count: list.length }
  }

  /** Current model route label for the panel footer. */
  function describeRoute(selection) {
    try {
      const route = resolveRoute(ctx, selection === null || selection === undefined ? {} : { selection })
      return { provider: route.provider, model: route.model }
    } catch {
      return { provider: null, model: null }
    }
  }

  return { summarize, describeRoute, correctTranscript, extractTodos, extractTerms, generateDigest }
}
