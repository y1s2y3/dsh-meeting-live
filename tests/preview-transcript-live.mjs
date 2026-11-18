/**
 * 视觉预览：把「原始转写」卡片在「录音中 / 停止后声纹分离」两种状态渲染成静态 HTML，
 * 用 dsh-browser 打开截图检查排版（不改真实数据、不需要录音设备）。
 *
 * 用法：node tests/preview-transcript-live.mjs
 * 产物：../browser-screenshots/preview-transcript-live.html
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const installedDir = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-meeting-live')
const pluginDir = process.argv[2] ?? (fs.existsSync(installedDir) ? installedDir : path.join(repoRoot, 'src'))
const clientFile = path.join(pluginDir, 'lib', 'client.js')
const outFile = path.join(repoRoot, 'browser-screenshots', 'preview-transcript-live.html')

const source = fs.readFileSync(clientFile, 'utf8')
const cssMatch = source.match(/const CSS = `([\s\S]*?)`\s*\n\s*const STYLE_TAG_ID/)
if (cssMatch === null) throw new Error('CSS block not found in client bundle')
const css = cssMatch[1]

/* ── 迷你 React：函数组件即时展开 + 独立 hook 上下文 ─────────────────── */
const Fragment = Symbol('Fragment')
function createElement(type, props, ...children) {
  const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
  const next = props === null || props === undefined ? {} : { ...props }
  if (flat !== undefined) next.children = flat
  return { type, props: next, isElement: true }
}
let hookContext = null
const React = {
  Component: class Component {
    constructor(props) { this.props = props; this.state = {} }
    setState() {}
  },
  createElement,
  Fragment,
  useState(init) {
    const ctx = hookContext
    const index = ctx.cursor
    ctx.cursor += 1
    if (!(index in ctx.states)) ctx.states[index] = typeof init === 'function' ? init() : init
    return [ctx.states[index], () => {}]
  },
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (fn) => fn(),
  useRef(value) {
    const ctx = hookContext
    const index = ctx.cursor
    ctx.cursor += 1
    if (!(index in ctx.refs)) ctx.refs[index] = { current: value }
    return ctx.refs[index]
  },
  useCallback: (fn) => fn,
  useContext: () => null,
  memo: (component) => component,
}
const fakeDocument = {
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, dataset: {}, textContent: '' }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
  hidden: false,
}
const fakeWindow = {
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  addEventListener() {},
  removeEventListener() {},
  location: { origin: 'http://127.0.0.1:43120' },
  __ModuleLoader__: { load: (options) => { globalThis.__captured = options } },
}
globalThis.window = fakeWindow
globalThis.document = fakeDocument
try {
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: null }, configurable: true, writable: true })
} catch {
  globalThis.navigator = { clipboard: null }
}
globalThis.fetch = async () => ({ ok: true, status: 200, async json() { return { ok: true } } })

let code = source
const hookAnchor = '    exports.apply = apply'
code = code.replace(hookAnchor, `    globalThis.__TEST_HOOKS__ = { MeetingDocument, MeetingPanel }
${hookAnchor}`)
;(0, eval)(code)
const captured = globalThis.__captured
captured.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
const hooks = globalThis.__TEST_HOOKS__

function renderComponent(component, props) {
  const previous = hookContext
  hookContext = { cursor: 0, states: [], refs: [] }
  try {
    return component(props)
  } finally {
    hookContext = previous
  }
}

const camelToKebab = (name) => name.replace(/[A-Z]/g, (char) => '-' + char.toLowerCase())
const escapeHtml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function styleToCss(style) {
  if (style === null || typeof style !== 'object') return ''
  return Object.entries(style).map(([key, value]) => `${camelToKebab(key)}:${value}`).join(';')
}
function toHtml(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(toHtml).join('')
  if (typeof node !== 'object' || node.isElement !== true) return ''
  if (typeof node.type === 'function') return toHtml(renderComponent(node.type, node.props ?? {}))
  // Fragment（React.Fragment 是 Symbol）：只渲染子节点
  if (typeof node.type === 'symbol') return toHtml(node.props?.children)
  const props = node.props ?? {}
  const attrs = []
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || key === 'key' || key === 'ref') continue
    if (typeof value === 'function') continue
    if (key === 'className') { attrs.push(`class="${escapeHtml(value)}"`); continue }
    if (key === 'style') { const style = styleToCss(value); if (style !== '') attrs.push(`style="${escapeHtml(style)}"`); continue }
    if (value === true) { attrs.push(key); continue }
    if (value === false || value === null || value === undefined) continue
    attrs.push(`${key}="${escapeHtml(value)}"`)
  }
  const open = `<${node.type}${attrs.length > 0 ? ' ' + attrs.join(' ') : ''}>`
  return open + toHtml(props.children) + `</${node.type}>`
}

/* ── 两种状态 ─────────────────────────────────────────────────────────── */
const segments = [
  { speaker: 'A', text: '我们先把巡检这块的改动过一遍，外部端新增的巡检功能之前是没有的。', at: 0 },
  { speaker: 'B', text: '表单跟移动端是一样的，指挥部这边也加了新的巡检任务入口。', at: 8 },
  { speaker: 'C', text: '新增两个配置功能：检查类型配置和隐患类别，都要加字段。', at: 16 },
  { speaker: 'D', text: '隐患类别按巡检分类走，每个分类下面单独配置。', at: 24 },
  { speaker: 'D', text: '这里其实是我们两个人在说话，一个是安全口、一个是质量口。', at: 32 },
]
const baseMeeting = {
  id: 'mt_live', title: '录音纪要 2026-11-17 16:05', date: '2026-11-17', attendees: ['安莉', '荣旺', '徐金杰'],
  sourceType: 'recording', transcriptSeconds: 1840, transcriptSegments: segments,
  speakerNames: {}, audioQuality: null, correction: null, notes: '', autoImported: false,
  media: [{ kind: 'audio', name: '会议录音-20261117-1725.wav', path: 'C:/fake/会议录音.wav', size: 148946988 }],
  summary: null, createdAt: '2026-11-17T08:06:15.995Z', updatedAt: new Date().toISOString(),
  transcript: segments.map((segment) => `${segment.speaker}：${segment.text}`).join('\n'),
}
function documentHtml(meeting, extra) {
  hookContext = null
  const tree = renderComponent(hooks.MeetingDocument, {
    meeting,
    summarizing: null,
    calendarAvailable: true,
    calendarError: '',
    exporting: false,
    recordDisabled: false,
    todosRegenerating: false,
    retranscribe: null,
    correction: null,
    live: null,
    diarizing: null,
    ...extra,
  })
  return toHtml(tree)
}

const liveHtml = documentHtml(baseMeeting, {
  live: { status: 'recording', elapsedSeconds: 1840, chars: 1293 },
  onPauseLive() {},
  onStopLive() {},
  onDiarize() {},
  onDiarizeSplit() {},
  onRetranscribe() {},
})
const diarizingHtml = documentHtml(baseMeeting, {
  live: { status: 'stopping', elapsedSeconds: 1840, chars: 1293 },
})
const doneHtml = documentHtml(
  {
    ...baseMeeting,
    transcriptSegments: [
      { speaker: 'S1', text: segments[0].text, at: 0 },
      { speaker: 'S2', text: segments[1].text, at: 8 },
      { speaker: 'S3', text: segments[2].text, at: 16 },
      { speaker: 'S2', text: segments[3].text, at: 24 },
      { speaker: 'S4', text: segments[4].text, at: 32 },
    ],
    transcript: segments.map((segment, index) => `S${index % 4 + 1}：${segment.text}`).join('\n'),
  },
  { diarizing: { phase: 'done', speakers: 4 } },
)

const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>会议纪要 · 原始转写预览</title>
<style>
html,body{margin:0;background:#F4F6FA;font-family:"Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif}
.preview-wrap{width:1180px;margin:0 auto;padding:16px 0 40px}
.preview-case{margin-bottom:18px}
.preview-label{font-size:12px;color:#64748B;margin:0 0 6px 2px;font-weight:600}
.preview-surface{background:#F4F6FA;border-radius:14px;padding:6px 2px}
.preview-note{font-size:11.5px;color:#94A3B8;margin:4px 0 0 2px}
${css}
</style></head>
<body>
<div class="preview-wrap">
  <div class="preview-case"><div class="preview-label">① 录音中（原始转写默认展开 + 实时条 + 暂停/停止）</div><div class="preview-surface"><div class="dsm-root"><div class="dsm-doc">${liveHtml}</div></div></div></div>
  <div class="preview-case"><div class="preview-label">② 正在收尾（声纹分离由下一状态展示）</div><div class="preview-surface"><div class="dsm-root"><div class="dsm-doc">${diarizingHtml}</div></div></div></div>
  <div class="preview-case"><div class="preview-label">③ 停止后声纹重新分离完成（S1/S2… + 人数提示）</div><div class="preview-surface"><div class="dsm-root"><div class="dsm-doc">${doneHtml}</div></div></div></div>
  <div class="preview-note">静态预览：只渲染 MeetingDocument 的文档区（无侧栏/工具栏）。数据为脱敏示例。</div>
</div>
</body></html>`

fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, page, 'utf8')
console.log(outFile)
