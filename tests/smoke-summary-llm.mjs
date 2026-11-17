/**
 * 离线测试：会议纪要的模型调用参数与失败重试策略。
 *
 * 背景（2026-11-17 实测）：deepseek-flash 默认带思考，插件原来只给 8192 输出预算，
 * 2 万字转写时 8192 个 token 全被 reasoning 吃掉、正文 0 字 → JSON 永远解析失败。
 * 修复后要求：
 *   ① 纪要调用显式 reasoningEffort='off'（关思考），maxTokens=16384；
 *   ② 第一次拿不到合法 JSON 时，用更大预算（32768）重试；
 *   ③ 还不行再用「更精简」的兜底指令试一次；
 *   ④ 适配器不支持显式 reasoningEffort 时自动降级，不把整个纪要卡死。
 *
 * 用法：node tests/smoke-summary-llm.mjs [插件目录]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const installedDir = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-meeting-live')
const pluginDir = process.argv[2] ?? (fs.existsSync(path.join(repoRoot, 'src', 'lib', 'summarize.js')) ? path.join(repoRoot, 'src') : installedDir)
const summarizeModule = await import(pathToFileURL(path.join(pluginDir, 'lib', 'summarize.js')).href)
const { createSummarizer } = summarizeModule

let failures = 0
function check(label, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ← ' + detail}`)
  if (!condition) failures += 1
}

const summaryJson = JSON.stringify({
  suggestedTitle: '巡检隐患流程与抽查功能评审',
  oneLine: '确定隐患按安全/质量/其他分级分流，并新增项目经理确认步骤。',
  overview: '本次会议逐条评审了巡检模块改造、隐患流程与抽查功能。' + '细节讨论'.repeat(40),
  keyPoints: ['巡检任务新增入口', '排查历史数据兼容方案'],
  keywords: ['巡检', '隐患'],
  decisions: [{ text: '质检与安全整改人分开配置', rationale: '流程要求区分', owner: '荣旺' }],
  risks: [{ text: '历史数据多选记录仍会存在', level: 'medium', suggestion: '前端只限制新增数据' }],
  sections: [{ heading: '巡检模块改造', summary: '确认外部端与指挥部端的入口与表单一致。', bullets: ['新增检查类型配置', '隐患类别按分类维护'] }],
  openQuestions: ['历史数据是否需要迁移'],
  speakerSummaries: [],
  attendees: ['安莉', '荣旺'],
  todos: [{ title: '修改流程图并再次评审', owner: '荣旺', due: '2026-11-18', priority: 'high', notes: '重点检查流程表达' }],
})

const meeting = {
  id: 'mt_mock',
  title: '巡检隐患流程与抽查功能评审',
  date: '2026-11-17',
  attendees: ['安莉', '荣旺'],
  notes: '',
  transcript: '安莉：先把巡检这块的改动过一遍。'.repeat(30),
  transcriptSegments: [],
  speakerNames: {},
  summary: null,
}

/** Build a fake ctx/llm. `replies` 是每次 stream 调用要吐出的回复（空串=没有正文）。 */
function makeHarness(replies, options = {}) {
  const calls = []
  const queue = replies.slice()
  const fakeLlm = {
    async prepareCall(config) {
      calls.push({ phase: 'prepare', config: { ...config } })
      if (options.rejectReasoning === true && config.reasoningEffort !== undefined) {
        throw new Error('UNSUPPORTED_REASONING_EFFORT: does not support reasoning effort off')
      }
      return {
        config: { ...config },
        stream() {
          const reply = queue.length > 0 ? queue.shift() : ''
          calls.push({ phase: 'stream', config: { ...config }, reply })
          return (async function* generate() {
            if (reply !== '') yield { type: 'text-delta', index: 0, text: reply }
            yield { type: 'finish', reason: options.finishKind === undefined ? { kind: 'stop' } : { kind: options.finishKind } }
          })()
        },
      }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'llm') return fakeLlm
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model', reasoningEffort: 'high' }) }
      return undefined
    },
  }
  return { ctx, calls }
}

/* 1. 正常一次成功：参数必须是 reasoningEffort=off + maxTokens=16384 */
{
  const { ctx, calls } = makeHarness([summaryJson])
  const summarizer = createSummarizer({ ctx, logger: { warn() {}, info() {} } })
  const summary = await summarizer.summarize(meeting, {})
  const prepare = calls.find((call) => call.phase === 'prepare')
  check('纪要调用成功并解析出摘要', summary !== null && typeof summary.oneLine === 'string' && summary.oneLine !== '')
  check('显式关闭思考（reasoningEffort=off）', prepare?.config.reasoningEffort === 'off', JSON.stringify(prepare?.config))
  check('输出预算放宽到 16384', prepare?.config.maxTokens === 16384, String(prepare?.config.maxTokens))
}

/* 2. 第一次被 max-tokens 截断：第二次用 32768 预算重试并成功 */
{
  const { ctx, calls } = makeHarness([summaryJson.slice(0, 40), summaryJson], { finishKind: 'max-tokens' })
  const summarizer = createSummarizer({ ctx, logger: { warn() {}, info() {} } })
  const summary = await summarizer.summarize(meeting, {})
  const streams = calls.filter((call) => call.phase === 'stream')
  const retryStream = streams[1]
  check('被截断后自动重试并成功', summary !== null && summary.oneLine !== '', JSON.stringify(summary?.oneLine ?? null))
  check('重试把输出预算提高到 32768', retryStream?.config.maxTokens === 32768, String(retryStream?.config.maxTokens))
}

/* 3. 前两次都不合法：用精简兜底 prompt 第三次成功 */
{
  const { ctx, calls } = makeHarness(['', '', summaryJson])
  const summarizer = createSummarizer({ ctx, logger: { warn() {}, info() {} } })
  const summary = await summarizer.summarize(meeting, {})
  const streams = calls.filter((call) => call.phase === 'stream')
  check('两次失败后走精简兜底并成功', summary !== null && streams.length === 3, `streams=${streams.length}`)
}

/* 4. 适配器不支持显式 reasoningEffort：降级后仍能产出纪要 */
{
  const { ctx, calls } = makeHarness([summaryJson], { rejectReasoning: true })
  const summarizer = createSummarizer({ ctx, logger: { warn() {}, info() {} } })
  const summary = await summarizer.summarize(meeting, {})
  const prepares = calls.filter((call) => call.phase === 'prepare')
  check('不支持 off 时自动降级', summary !== null && prepares.length >= 2, `prepare calls=${prepares.length}`)
  check('降级后不再携带 reasoningEffort', prepares.some((call) => call.config.reasoningEffort === undefined))
}

/* 5. 三次都拿不到 JSON：给出可操作的错误文案 */
{
  const { ctx } = makeHarness(['', '', ''])
  const summarizer = createSummarizer({ ctx, logger: { warn() {}, info() {} } })
  let message = ''
  try {
    await summarizer.summarize(meeting, {})
  } catch (error) {
    message = String(error?.message ?? '')
  }
  check('三次失败给出明确错误与建议', message.includes('已自动重试 2 次') && message.includes('换一个模型'), message)
}

/* 6. 纠错调用同样关思考（长转写不重复踩坑） */
{
  const corrected = '安莉：先把巡检这块的改动过一遍。'.repeat(30)
  const { ctx, calls } = makeHarness([corrected])
  const summarizer = createSummarizer({ ctx, logger: { warn() {}, info() {} } })
  await summarizer.correctTranscript(meeting, {})
  const prepare = calls.find((call) => call.phase === 'prepare')
  check('转写纠错同样 reasoningEffort=off', prepare?.config.reasoningEffort === 'off', JSON.stringify(prepare?.config))
}

console.log('')
if (failures > 0) {
  console.error(`FAILED: ${failures} case(s)`)
  process.exit(1)
}
console.log('ALL SUMMARY LLM CHECKS PASSED')
