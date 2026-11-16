/**
 * 离线工具层自测：用临时 DSH_HOME + 假 ctx，把 tools.js 注册的 agent 工具
 * 真实执行一遍（store / export / summarize 都是真代码，只有 DSH 待办与外部
 * 语音服务是假的）。
 *
 * 覆盖此前三个真实缺陷的回归：
 *   1) meeting_get 在「还没有纪要」时也返回原始文本（includeTranscript）
 *   2) meeting_push_todos / 面板「写入待办」读 summary.todos（不是 meeting.todos）
 *   3) 手动配置总结模型（callCustomModel）可用，缺配置给中文提示而不是 ReferenceError
 *
 * 用法：node tests/smoke-tools.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'src', 'lib')
const imp = (file) => import(pathToFileURL(path.join(SRC, file)).href)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tools-'))
process.env.DSH_HOME = tmp

const { MeetingStore } = await imp('store.js')
const { registerTools } = await imp('tools.js')
const { createSummarizer } = await imp('summarize.js')
const { exportMeeting } = await imp('export.js')

let failures = 0
function check(label, condition, detail) {
  const ok = !!condition
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  :: ' + detail}`)
}

const SAMPLE_SUMMARY = {
  suggestedTitle: 'Q4预算评审与投放排期',
  oneLine: 'Q4预算按渠道拆分，投放排期顺延两周。',
  overview: '会议确认了Q4预算总额与拆分方式，并调整了投放排期。',
  keyPoints: ['预算总额 800 万', '渠道按 5:3:2 拆分', '投放顺延两周'],
  decisions: [{ text: '预算总额定为 800 万', owner: '张伟' }],
  risks: [{ text: '排期顺延可能影响预热', level: 'high' }],
  sections: [{ heading: '预算', bullets: ['总额 800 万', '分渠道拆分'] }],
  attendees: ['张伟', '李娜'],
  todos: [
    { title: '提交Q4预算拆分表', owner: '张伟', due: '2026-11-20', priority: 'high', notes: '' },
    { title: '更新投放排期甘特图', owner: '李娜', due: '2026-11-25', priority: 'normal', notes: '' },
  ],
}

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} }
const store = new MeetingStore({ logger: quietLogger })
await store.load()
/** 按顺序排队给假模型用的回复；空队列时回 SAMPLE_SUMMARY。 */
const llmReplies = []

const tools = new Map()
const fakeCtx = {
  logger: quietLogger,
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => {}
    },
  },
  get(name) {
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) }
    if (name === 'llm') {
      return {
        async prepareCall() {
          return {
            config: {},
            stream: async function* () {
              const reply = llmReplies.length > 0 ? llmReplies.shift() : JSON.stringify(SAMPLE_SUMMARY)
              yield { type: 'text-delta', text: reply }
              yield { type: 'finish', reason: { kind: 'stop' } }
            },
          }
        },
      }
    }
    return undefined
  },
}

const summarizer = createSummarizer({ ctx: fakeCtx, logger: quietLogger })
const todoWrites = []
const fakeDshTodo = {
  async ready() { return true },
  status() { return { available: true, target: 'dsh-todo', dir: path.join(tmp, 'memories') } },
  add(content, meta = {}) {
    todoWrites.push({ content, meta })
    return { ok: true, id: 'smoke' + todoWrites.length }
  },
}
registerTools(fakeCtx, {
  ctx: fakeCtx,
  store,
  asr: { async transcribeFile() { return { text: '这是转写出来的会议文本。', audioSeconds: 12.5, inferenceSeconds: 0.4 } } },
  summarizer,
  calendar: { status: async () => ({ available: false }) },
  autoIngest: {
    async setConfig() {},
    async scanNow() {},
    status() {
      return {
        enabled: true, scanning: false, tencentAvailable: false, tencentError: '未找到数据库',
        dirs: [], importedCount: 0, failedCount: 0, lastScanAt: null, recent: [], lastError: null,
      }
    },
  },
  dshTodo: fakeDshTodo,
  logger: quietLogger,
})

const call = (name, args) => tools.get(name).execute(args)

/* ── 创建 / 列表 / 读取 ───────────────────────────────────────── */
const created = await call('meeting_create', {
  title: '工具层验证会',
  date: '2026-11-13',
  attendees: ['张伟', '李娜'],
  transcript: '张伟：Q4预算总额定 800 万，按渠道 5:3:2 拆分，投放排期顺延两周。李娜：排期我来更新。',
})
const id = /mt_[a-z0-9]+/.exec(created)?.[0]
check('meeting_create 创建成功并返回 id', created.includes('已创建会议记录') && typeof id === 'string', id)

const list = await call('meeting_list', {})
check('meeting_list 列出新会议', list.includes('工具层验证会'))

const got = await call('meeting_get', { id, includeTranscript: true })
check('meeting_get（未生成纪要时）也返回原始文本', got.includes('Q4预算总额'), got.split('\n').slice(0, 2).join(' / '))

/* ── 导出 ─────────────────────────────────────────────────────── */
const md = await exportMeeting(store.get(id), 'md')
const html = await exportMeeting(store.get(id), 'html')
check('export markdown 落盘且包含正文', fs.existsSync(md.path) && fs.readFileSync(md.path, 'utf8').includes('Q4预算总额'))
check('export html 落盘', fs.existsSync(html.path) && fs.readFileSync(html.path, 'utf8').includes('<html'))

/* ── 纪要生成（DSH 默认模型路径） ─────────────────────────────── */
const summarized = await call('meeting_summarize', { id })
check('meeting_summarize（DSH 模式）成功', summarized.includes('已生成会议纪要'))
check('纪要解析出 2 条待办', store.get(id).summary?.todos?.length === 2, String(store.get(id).summary?.todos?.length))
check('参会人回填', store.get(id).attendees.join('、') === '张伟、李娜')

/* 首次纪要没待办时，会再补一次行动项抽取（安静/碎片转写的兜底） */
llmReplies.push(
  JSON.stringify({ ...SAMPLE_SUMMARY, todos: [] }),
  JSON.stringify({ todos: [{ title: '补一份排期表', owner: '', due: '', priority: 'normal', notes: '' }] }),
)
const fallbackMeeting = {
  ...store.get(id),
  summary: null,
  transcript: '这是一段足够长的会议转写文本，用来触发待办补抽逻辑。'.repeat(10),
}
const fallbackSummary = await summarizer.summarize(fallbackMeeting)
check('首次纪要没待办时会再抽一次行动项', fallbackSummary.todos.length === 1
  && fallbackSummary.todos[0].title.includes('排期'), JSON.stringify(fallbackSummary.todos))

/* ── 写入待办 ─────────────────────────────────────────────────── */
const pushed = await call('meeting_push_todos', { id })
check('meeting_push_todos 读 summary.todos 并写入 2 条', todoWrites.length === 2 && pushed.includes('已写入 DSH 待办 2 条'), pushed.split('\n')[0])
check('写入工作轨 cat=会议纪要', todoWrites[0]?.meta?.cat === '会议纪要', JSON.stringify(todoWrites[0]?.meta))
check('高优先级映射 q1', todoWrites[0]?.meta?.quadrant === 'q1')
check('待办进度写回会议', store.get(id).summary.todos.every((todo) => String(todo.calendarTaskId ?? '').startsWith('dsh-todo:')))

/* ── 待办弃用 / 恢复 / 重新生成保留弃用状态 ───────────────────── */
{
  const target = store.get(id)
  const firstTodo = target.summary.todos[0]
  await store.patchTodo(id, firstTodo.id, { dropped: true })
  const afterDrop = store.get(id).summary.todos.find((todo) => todo.id === firstTodo.id)
  check('待办可标记弃用并记录时间', afterDrop.dropped === true && typeof afterDrop.droppedAt === 'string', JSON.stringify({ dropped: afterDrop.dropped, at: afterDrop.droppedAt }))
  await store.patchTodo(id, firstTodo.id, { dropped: false })
  const afterRestore = store.get(id).summary.todos.find((todo) => todo.id === firstTodo.id)
  check('待办弃用后可以恢复', afterRestore.dropped === false && afterRestore.droppedAt === null, JSON.stringify({ dropped: afterRestore.dropped }))

  const { normalizeSummary } = await imp('model.js')
  const regenerated = normalizeSummary(
    { todos: [{ title: afterRestore.title, owner: afterRestore.owner }] },
    { previous: { todos: [{ ...afterRestore, dropped: true, droppedAt: '2026-11-16T00:00:00.000Z' }] } },
  )
  check('重新生成纪要时保留弃用状态', regenerated.todos[0].dropped === true && regenerated.todos[0].droppedAt === '2026-11-16T00:00:00.000Z', JSON.stringify(regenerated.todos[0]))
}

/* ── 音频转写（假 ASR → 真 store） ─────────────────────────────── */
const transcribed = await call('meeting_transcribe', { audioPath: 'C:/fake/meeting.wav', title: '录音验证会' })
check('meeting_transcribe 建记录并写入文本', transcribed.includes('已转写 13 秒音频') && store.meetings.some((meeting) => meeting.title === '录音验证会'))

/* ── 自动入库状态 ─────────────────────────────────────────────── */
const autoStatus = await call('meeting_auto_ingest', { action: 'status' })
check('meeting_auto_ingest status 可读', autoStatus.includes('自动识别：开启'))

/* ── 手动配置的总结模型（OpenAI 兼容接口） ─────────────────────── */
const server = http.createServer((req, res) => {
  req.on('data', () => {})
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(SAMPLE_SUMMARY) } }] }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
await store.setSettings({ summary: { mode: 'custom', custom: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'mock-model', temperature: 0.3, maxTokens: 8192 } } })
try {
  const custom = await call('meeting_summarize', { id })
  check('meeting_summarize（手动配置模型）成功', custom.includes('已生成会议纪要'), custom.split('\n')[0])
} catch (error) {
  check('meeting_summarize（手动配置模型）成功', false, String(error?.message ?? error))
}
server.close()

await store.setSettings({ summary: { mode: 'custom', custom: { baseUrl: '', apiKey: '', model: '', temperature: 0.3, maxTokens: 8192 } } })
try {
  await call('meeting_summarize', { id })
  check('手动模型缺配置时给中文提示', false, '没有抛错')
} catch (error) {
  const message = String(error?.message ?? error)
  check('手动模型缺配置时给中文提示', message.includes('填写接口地址与模型名'), message)
}

fs.rmSync(tmp, { recursive: true, force: true })
if (failures === 0) console.log('\nALL TOOL CHECKS PASSED')
else console.log(`\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

