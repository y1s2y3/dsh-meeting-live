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
/** Output-token cap for one summary attempt. */
const MAX_TOKENS = 8192

/** System instruction: role, output contract, and grounding rules. */
export const SYSTEM_PROMPT = [
  '你是一位专业的中文会议纪要助理。你会读到一场会议的标题、日期、参会人和完整转写/纪要文本。',
  '你的任务是把内容整理成结构化的会议纪要 JSON，供后续渲染成可视化文档并抽取待办。',
  '',
  '硬性要求：',
  '1. 只输出一个 JSON 对象，不要输出 Markdown 代码围栏、解释、前言或后记。',
  '2. 严格使用下面给出的字段名和类型，不要增删字段、不要改字段名。',
  '3. 只依据提供的文本，不要编造事实、人名、数字或日期；文本没提到的信息留空字符串或空数组。',
  '4. 待办优先提取“有明确交付物 + 有负责人或明确截止时间”的行动项；若讨论明确了下一步要做什么、但没提到谁做或何时做，也要生成待办（owner/due 留空），不要因为信息不全就整场不输出待办。',
  '4.1 转写可能由 5 秒分片拼接而成、有断句和错字，请按语义合并理解，不要因为文本碎片就忽略行动项；todos 通常 3-8 条，确实没有任何行动信息时才给空数组。',
  '5. 相对时间（“下周三”“本周五前”“月底”）必须换算成具体日期：日期用 YYYY-MM-DD，带时刻用 YYYY-MM-DD HH:mm；无法确定就留空字符串。',
  '6. 使用参会文本本身的语言；中文会议就用中文。',
  '7. oneLine 不超过 60 个汉字；overview 不超过 300 个汉字；keyPoints 3-8 条；sections 按议题分节，每节 2-8 条要点。',
  '8. suggestedTitle 用 8-20 个汉字概括会议主题（例如“Q4预算评审与投放排期”），不要用“会议纪要”“讨论”等空泛词。',
  '',
  '输出 JSON 形状：',
  '{',
  '  "suggestedTitle": "为这场会议起一个 8-20 字的标题，概括主题，不要写“会议纪要”“讨论”这类空话",',
  '  "oneLine": "一句话结论",',
  '  "overview": "整体概述",',
  '  "keyPoints": ["关键要点"],',
  '  "decisions": [{"text": "已决定的事项", "owner": "负责人或空"}],',
  '  "risks": [{"text": "风险或待确认事项", "level": "low|medium|high"}],',
  '  "sections": [{"heading": "议题标题", "bullets": ["该议题下的要点"]}],',
  '  "attendees": ["从文本中能确认的参会人"],',
  '  "todos": [{"title": "交付物", "owner": "负责人或空", "due": "截止时间或空", "priority": "high|normal|low", "notes": "验收标准或补充信息"}]',
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

/** 行动项抽取的用户消息：会议信息 + 已识别决策/风险 + 转写全文。 */
export function buildTodoExtractPrompt(meeting, summary = {}) {
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
  const lines = [
    `会议标题：${meeting.title}`,
    `会议日期：${meeting.date}`,
    `参会人：${meeting.attendees.length > 0 ? meeting.attendees.join('、') : '（未提供）'}`,
    meeting.notes === '' ? '' : `补充说明：${meeting.notes}`,
    '',
    '会议文本如下（可能是转写稿或腾讯会议纪要原文）：',
    '----- 会议文本开始 -----',
    clampTranscript(meeting.transcript),
    '----- 会议文本结束 -----',
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
   */
  async function callModel(messages, system, signal, selection) {
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
    try {
      let call
      try {
        call = await llm.prepareCall({
          provider: route.provider,
          model: route.model,
          maxTokens: MAX_TOKENS,
        }, controller.signal)
      } catch (error) {
        // Some routes cap output tokens below this request; retry once with the
        // adapter's own default cap instead of failing the whole summary.
        if (!/max.?tokens|output/i.test(String(error?.message ?? ''))) throw error
        call = await llm.prepareCall({ provider: route.provider, model: route.model }, controller.signal)
      }
      const streamOptions = {
        ...call.config,
        messages,
        system,
        signal: controller.signal,
      }
      const { text } = await collectStream(call.stream(streamOptions))
      return { text, route }
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
    const callModelFn = async (messages, system) => {
      if (custom !== null) return callCustomModel(messages, system, custom, signal)
      return callModel(messages, system, signal, options.selection ?? null)
    }
    const messages = [{ role: 'user', content: [{ type: 'text', text: buildUserPrompt(meeting) }] }]
    const first = await callModelFn(messages, SYSTEM_PROMPT)
    const parsed = parseSummaryJson(first.text)
    if (parsed !== null) {
      const withTodos = await ensureTodos(parsed, meeting, callModelFn)
      return normalizeSummary(withTodos, {
        previous: meeting.summary,
        now: new Date(),
        model: `${first.route.provider}/${first.route.model}`,
      })
    }
    logger?.warn?.('meeting-minutes: first summary reply was not JSON, retrying once')
    const repairMessages = [{
      role: 'user',
      content: [{ type: 'text', text: buildRepairPrompt(first.text, meeting) }],
    }]
    const second = await callModelFn(repairMessages, SYSTEM_PROMPT)
    const repaired = parseSummaryJson(second.text)
    if (repaired === null) {
      throw new Error('模型返回的纪要格式无法解析，请重试一次；若持续失败，可换一个模型再生成。')
    }
    const repairedWithTodos = await ensureTodos(repaired, meeting, callModelFn)
    return normalizeSummary(repairedWithTodos, {
      previous: meeting.summary,
      now: new Date(),
      model: `${second.route.provider}/${second.route.model}`,
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
    const instruction = [
      '你是中文会议转写的校对员。请只修正错别字、同音字、专有名词（术语/系统名/人名）与明显断词，',
      '不要改写句式、不要删减内容、不要总结、不要添加原文没有的信息。',
      '保持原有的换行与说话人标记（如 S1：、A：）不变。',
      '如果原文没有标点（Paraformer 输出通常无标点），请补全逗号、句号、问号等标点并合理断句。',
      terms.length > 0 ? '优先使用这些术语的正确写法：' + terms.join('、') : '',
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

  /** Current model route label for the panel footer. */
  function describeRoute(selection) {
    try {
      const route = resolveRoute(ctx, selection === null || selection === undefined ? {} : { selection })
      return { provider: route.provider, model: route.model }
    } catch {
      return { provider: null, model: null }
    }
  }

  return { summarize, describeRoute, correctTranscript, extractTodos }
}
