/**
 * 离线测试：原始转写卡片的「默认展开 + 录音中实时条 + 声纹分离状态」。
 * 用桩 React 直接渲染客户端 bundle 里的 TranscriptSection / MeetingDocument，
 * 不依赖真实录音设备与宿主。
 *
 * 用法：node tests/smoke-transcript-live.mjs [插件目录]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const installedDir = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-meeting-live')
const pluginDir = process.argv[2] ?? (fs.existsSync(installedDir) ? installedDir : path.join(repoRoot, 'src'))
const file = path.join(pluginDir, 'lib', 'client.js')

/* ── 桩 React ─────────────────────────────────────────────────────────── */
const Fragment = Symbol('Fragment')
function createElement(type, props, ...children) {
  const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
  const next = props === null || props === undefined ? {} : { ...props }
  if (flat !== undefined) next.children = flat
  return { type, props: next, isElement: true }
}
let hookCursor = 0
const hookStates = []
const hookRefs = []
const React = {
  Component: class Component {
    constructor(props) { this.props = props; this.state = {}; }
    setState(update) {
      const next = typeof update === 'function' ? update(this.state) : update
      this.state = { ...this.state, ...(next ?? {}) }
    }
  },
  createElement,
  Fragment,
  useState(init) {
    const index = hookCursor
    hookCursor += 1
    if (!(index in hookStates)) hookStates[index] = typeof init === 'function' ? init() : init
    return [hookStates[index], (value) => { hookStates[index] = typeof value === 'function' ? value(hookStates[index]) : value }]
  },
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (fn) => fn(),
  useRef(value) {
    const index = hookCursor
    hookCursor += 1
    if (!(index in hookRefs)) hookRefs[index] = { current: value }
    return hookRefs[index]
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
const memory = new Map()
const fakeLocalStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => { memory.set(key, String(value)) },
  removeItem: (key) => { memory.delete(key) },
}
const fakeWindow = {
  localStorage: fakeLocalStorage,
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
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: null, mediaDevices: null }, configurable: true, writable: true })
} catch {
  globalThis.navigator = { clipboard: null, mediaDevices: null }
}
globalThis.fetch = async () => ({ ok: true, status: 200, async json() { return { ok: true } } })
globalThis.localStorage = fakeLocalStorage

/* ── 执行 bundle 并暴露被测组件 ──────────────────────────────────────── */
let code = fs.readFileSync(file, 'utf8')
const hookAnchor = '    exports.apply = apply'
code = code.replace(hookAnchor, `    globalThis.__TEST_HOOKS__ = {
      TranscriptSection,
      MeetingDocument,
      resetHooks: () => { hookCursor = 0; hookStates.length = 0; hookRefs.length = 0 },
    }
${hookAnchor}`)
const requireStub = (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}
;(0, eval)(code)
const captured = globalThis.__captured
captured.factory(requireStub)
const hooks = globalThis.__TEST_HOOKS__

let failures = 0
function check(label, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ← ' + detail}`)
  if (!condition) failures += 1
}
function render(component, props) {
  hookCursor = 0
  hookStates.length = 0
  hookRefs.length = 0
  return component(props)
}
function classes(node, found = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return found
  if (Array.isArray(node)) { node.forEach((child) => classes(child, found)); return found }
  if (typeof node !== 'object' || node.isElement !== true) return found
  const className = typeof node.props?.className === 'string' ? node.props.className : ''
  if (className !== '') found.push(className)
  classes(node.props?.children, found)
  return found
}
function texts(node, found = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return found
  if (Array.isArray(node)) { node.forEach((child) => texts(child, found)); return found }
  if (typeof node === 'string') { found.push(node); return found }
  if (typeof node !== 'object' || node.isElement !== true) return found
  texts(node.props?.children, found)
  return found
}
const hasClass = (node, part) => classes(node).some((name) => name.includes(part))
const joinedText = (node) => texts(node).join(' ')
/** 在元素树里找某个组件类型的元素（函数组件本身不展开，直接把 props 拿出来单独渲染）。 */
function findComponent(node, component, found = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return found
  if (Array.isArray(node)) { node.forEach((child) => findComponent(child, component, found)); return found }
  if (typeof node !== 'object' || node.isElement !== true) return found
  if (node.type === component) found.push(node)
  findComponent(node.props?.children, component, found)
  return found
}

/* 1. 有分段时默认展开（不用再点「展开」） */
const segments = [
  { speaker: 'A', text: '今天先过一下进度。', at: 0 },
  { speaker: 'D', text: '这是另一个人在说话。', at: 5 },
]
const expandedTree = render(hooks.TranscriptSection, {
  transcript: 'A：今天先过一下进度。\nD：这是另一个人在说话。',
  segments,
  speakerNames: {},
  live: null,
  diarizing: null,
})
check('原始转写默认展开（dsm-transcript-lines--open）', hasClass(expandedTree, 'dsm-transcript-lines--open'))
check('分段行按说话人渲染', classes(expandedTree).filter((name) => name.includes('dsm-speaker ')).length >= 2
  || classes(expandedTree).some((name) => name.includes('dsm-speaker--d')), JSON.stringify(classes(expandedTree).slice(0, 12)))
check('有分段时不会出现「收起」态提示', !hasClass(expandedTree, 'dsm-transcript-live'))
check('每一段都显示时间戳（mm:ss）', classes(expandedTree).filter((name) => name.includes('dsm-transcript-time')).length === 2
  && joinedText(expandedTree).includes('00:00') && joinedText(expandedTree).includes('00:05'), JSON.stringify(classes(expandedTree).slice(0, 12)))
const diarizeButtonTree = render(hooks.TranscriptSection, {
  transcript: 'A：x', segments, speakerNames: {}, live: null, diarizing: null, hasAudio: true, onDiarize() {},
})
/** 操作按钮在 Section 组件的 props.actions 里（函数组件不展开），需要按 props.title 找到它。 */
function sectionActionsText(tree, title) {
  const stack = [tree]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === null || node === undefined) continue
    if (Array.isArray(node)) { stack.push(...node); continue }
    if (typeof node !== 'object' || node.isElement !== true) continue
    if (node.props?.title === title) return joinedText(node.props?.actions)
    stack.push(node.props?.children)
  }
  return ''
}
const diarizeActionsText = sectionActionsText(diarizeButtonTree, '原始转写')
const plainActionsText = sectionActionsText(expandedTree, '原始转写')
check('传了 onDiarize 且有音频时显示「重新分离说话人」', !plainActionsText.includes('重新分离说话人')
  && diarizeActionsText.includes('重新分离说话人'), diarizeActionsText.slice(0, 120))
check('没有音频文件时不显示「重新分离说话人」', !plainActionsText.includes('重新分离说话人'), plainActionsText.slice(0, 120))

/* 1.b 长会议时间戳带小时位；没有 at 的旧数据不显示时间 */
{
  const hoursTree = render(hooks.TranscriptSection, {
    transcript: 'A：x\nB：y',
    segments: [{ speaker: 'A', text: '第一段', at: 3725 }, { speaker: 'B', text: '第二段', at: 60 }],
    speakerNames: {},
    live: null,
    diarizing: null,
  })
  check('超过 1 小时显示 1:02:05', joinedText(hoursTree).includes('1:02:05'), joinedText(hoursTree).slice(0, 80))
  const legacyTree = render(hooks.TranscriptSection, {
    transcript: 'A：x',
    segments: [{ speaker: 'A', text: '旧数据没有时间' }],
    speakerNames: {},
    live: null,
    diarizing: null,
  })
  check('旧分段没有 at 时不显示假时间', classes(legacyTree).filter((name) => name.includes('dsm-transcript-time')).length === 0)
}

/* 2. 录音中：实时条 + 计时 + 已转写字数 + 暂停/停止按钮 */
const liveTree = render(hooks.TranscriptSection, {
  transcript: 'A：今天先过一下进度。',
  segments,
  speakerNames: {},
  live: { status: 'recording', elapsedSeconds: 61, chars: 12 },
  diarizing: null,
  onPauseLive() {},
  onStopLive() {},
})
const liveText = joinedText(liveTree)
check('录音中显示实时条', hasClass(liveTree, 'dsm-transcript-live'))
check('实时条显示「录音中」与计时/字数', liveText.includes('录音中') && liveText.includes('01:01') && liveText.includes('12'), liveText.slice(0, 120))
check('实时条提供暂停 / 停止并保存按钮', liveText.includes('暂停') && liveText.includes('停止并保存'))
check('录音中提示音色估算是临时分组', liveText.includes('按音色临时估算') && liveText.includes('声纹'), liveText.slice(0, 200))

const pausedTree = render(hooks.TranscriptSection, {
  transcript: 'A：今天先过一下进度。',
  segments,
  speakerNames: {},
  live: { status: 'paused', elapsedSeconds: 61, chars: 12 },
  diarizing: null,
  onPauseLive() {},
  onStopLive() {},
})
check('暂停时实时条显示「已暂停 · 继续」', joinedText(pausedTree).includes('已暂停') && joinedText(pausedTree).includes('继续'))

/* 3. 声纹重新分离的三种状态 */
const runningTree = render(hooks.TranscriptSection, {
  transcript: 'A：一\nD：二',
  segments,
  speakerNames: {},
  live: null,
  diarizing: { phase: 'running' },
})
check('声纹分离进行中显示进度条文案', joinedText(runningTree).includes('正在用声纹（音色）重新分离说话人'))

const doneTree = render(hooks.TranscriptSection, {
  transcript: 'S1：一\nS2：二',
  segments: [{ speaker: 'S1', text: '一', at: 0 }, { speaker: 'S2', text: '二', at: 5 }],
  speakerNames: {},
  live: null,
  diarizing: { phase: 'done', speakers: 2 },
})
check('声纹分离完成提示人数', joinedText(doneTree).includes('已按音色重新分离') && joinedText(doneTree).includes('2 位说话人'), joinedText(doneTree).slice(-160))
check('S1/S2 标签不再提示「A/B/C/D 估算」', !joinedText(doneTree).includes('A/B/C/D 为按音色自动分组'), joinedText(doneTree).slice(-200))

const timeoutTree = render(hooks.TranscriptSection, {
  transcript: 'A：一\nD：二',
  segments,
  speakerNames: {},
  live: null,
  diarizing: { phase: 'timeout' },
})
check('声纹分离超时给出黄色提示', hasClass(timeoutTree, 'dsm-transcript-status--warn') && joinedText(timeoutTree).includes('声纹分离还没完成'))

const errorTree = render(hooks.TranscriptSection, {
  transcript: 'A：一\nD：二',
  segments,
  speakerNames: {},
  live: null,
  diarizing: { phase: 'error', note: '说话人分离模型未就绪' },
})
check('声纹分离失败显示原因', hasClass(errorTree, 'dsm-transcript-status--warn') && joinedText(errorTree).includes('说话人分离模型未就绪'), joinedText(errorTree).slice(-120))

/* 4. 录音中即使一个字都还没识别，MeetingDocument 也渲染原始转写卡片 */
const meeting = {
  id: 'mt_live', title: '录音纪要 2026-11-17 16:05', date: '2026-11-17', attendees: [],
  transcript: '', transcriptSegments: [], speakerNames: {}, media: [], notes: '', sourceType: 'recording',
  summary: null,
}
const docTree = render(hooks.MeetingDocument, {
  meeting,
  summarizing: null,
  calendarAvailable: true,
  calendarError: '',
  exporting: false,
  recordDisabled: false,
  todosRegenerating: false,
  retranscribe: null,
  correction: null,
  live: { status: 'preparing', elapsedSeconds: 3, chars: 0 },
  diarizing: null,
  onPauseLive() {},
  onStopLive() {},
})
const docTranscripts = findComponent(docTree, hooks.TranscriptSection)
check('录音中未出字时也显示原始转写卡片', docTranscripts.length === 1 && docTranscripts[0].props.live !== null)
const liveSectionTree = docTranscripts.length > 0 ? render(hooks.TranscriptSection, docTranscripts[0].props) : null
check('未出字时提示等待第一段识别结果', liveSectionTree !== null && joinedText(liveSectionTree).includes('正在等待第一段识别结果'), liveSectionTree === null ? 'no section' : joinedText(liveSectionTree).slice(0, 160))
check('录音中隐藏「还没有转写内容」的 CTA', !joinedText(docTree).includes('还没有转写内容'))

/* 5. 非录音会议：默认展开还是生效 */
const plainTree = render(hooks.MeetingDocument, {
  meeting: { ...meeting, transcript: 'A：一\nD：二', transcriptSegments: segments },
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
})
const plainTranscripts = findComponent(plainTree, hooks.TranscriptSection)
const plainSectionTree = plainTranscripts.length > 0 ? render(hooks.TranscriptSection, plainTranscripts[0].props) : null
check('历史会议的原始转写同样默认展开', plainSectionTree !== null && hasClass(plainSectionTree, 'dsm-transcript-lines--open'))

console.log('')
if (failures > 0) {
  console.error(`FAILED: ${failures} case(s)`)
  process.exit(1)
}
console.log('ALL PASS')
