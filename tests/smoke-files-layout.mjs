/**
 * 离线测试：会议文件行的布局与点击反馈结构。
 *
 * 回归点（2026-11-17 实测）：只有音频时文件行本来占满一整行，点「查看目录」后变成半行宽。
 * 根因是「操作结果提示」被放进 .dsm-files 的 auto-fit 网格里，被当成第二个网格项。
 * 修复后：提示渲染在网格外（Fragment 的第二个子节点），网格子项数始终等于文件数。
 *
 * 用法：node tests/smoke-files-layout.mjs [插件目录]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const installedDir = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-meeting-live')
const pluginDir = process.argv[2] ?? (fs.existsSync(path.join(repoRoot, 'src', 'lib', 'client.js')) ? path.join(repoRoot, 'src') : installedDir)
const clientFile = path.join(pluginDir, 'lib', 'client.js')

/* ── 桩 React：hook 状态跨多次渲染保留（同一组件重复渲染用） ─────────── */
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
    setState() {}
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
globalThis.fetch = async (url) => {
  const target = String(url)
  const payload = { ok: true, revealed: true, opened: true }
  return {
    ok: true,
    status: 200,
    async json() { return target.includes('/media/reveal') || target.includes('/media/open') ? payload : { ok: true } },
    async text() { return JSON.stringify(payload) },
  }
}

/* ── 载入 bundle，暴露 MeetingFiles ───────────────────────────────────── */
let code = fs.readFileSync(clientFile, 'utf8')
const hookAnchor = '    exports.apply = apply'
code = code.replace(hookAnchor, `    globalThis.__TEST_HOOKS__ = { MeetingFiles }
${hookAnchor}`)
;(0, eval)(code)
const captured = globalThis.__captured
captured.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
const { MeetingFiles } = globalThis.__TEST_HOOKS__

let failures = 0
function check(label, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ← ' + detail}`)
  if (!condition) failures += 1
}
function render(props) {
  hookCursor = 0
  return MeetingFiles(props)
}
function childrenOf(node) {
  const children = node?.props?.children
  if (children === undefined || children === null) return []
  return Array.isArray(children) ? children : [children]
}
function find(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) { node.forEach((child) => find(child, predicate, out)); return out }
  if (typeof node !== 'object' || node.isElement !== true) return out
  if (predicate(node)) out.push(node)
  find(node.props?.children, predicate, out)
  return out
}
const byClass = (node, cls) => find(node, (element) => typeof element.props?.className === 'string' && element.props.className.includes(cls))
const textOf = (node) => {
  const texts = []
  const walk = (current) => {
    if (current === null || current === undefined || typeof current === 'boolean') return
    if (Array.isArray(current)) { current.forEach(walk); return }
    if (typeof current === 'string' || typeof current === 'number') { texts.push(String(current)); return }
    if (typeof current !== 'object' || current.isElement !== true) return
    walk(current.props?.children)
  }
  walk(node)
  return texts.join(' ')
}

const audioOnly = [{ kind: 'audio', name: '会议录音-20261117-1725.wav', bytes: 148000000, seconds: 4655 }]
const audioAndVideo = [
  { kind: 'audio', name: '会议录音-20261117-1725.wav', bytes: 148000000, seconds: 4655 },
  { kind: 'video', name: '会议录音-20261117-1725.mp4', bytes: 200000000, seconds: 4655 },
]

/* 1. 只有音频：网格里只有 1 个文件行，没有提示（保持整行宽） */
{
  const tree = render({ meetingId: 'mt_mock', media: audioOnly })
  const files = byClass(tree, 'dsm-files')
  check('只有音频时渲染文件网格', files.length === 1)
  check('网格里只有 1 个子项（不会挤成半宽）', files.length === 1 && childrenOf(files[0]).filter((child) => child && child.isElement === true).length === 1,
    String(files.length === 1 ? childrenOf(files[0]).filter((child) => child && child.isElement === true).length : -1))
  check('初始没有操作结果提示', byClass(tree, 'dsm-file-status').length === 0)
}

/* 2. 点击「查看目录」：提示出现在网格外，网格子项数不变 */
{
  render({ meetingId: 'mt_mock', media: audioOnly })
  const tree = render({ meetingId: 'mt_mock', media: audioOnly })
  const revealButton = find(tree, (element) => element.type === 'button' && textOf(element).includes('查看目录'))[0]
  check('找到「查看目录」按钮', revealButton !== undefined)
  revealButton?.props?.onClick?.()
  await new Promise((resolve) => setTimeout(resolve, 40))
  const after = render({ meetingId: 'mt_mock', media: audioOnly })
  const files = byClass(after, 'dsm-files')
  const status = byClass(after, 'dsm-file-status')
  check('点击后出现结果提示', status.length === 1, String(status.length))
  check('提示在网格外面（不是 .dsm-files 的子项）', find(files[0], (element) => typeof element.props?.className === 'string' && element.props.className.includes('dsm-file-status')).length === 0)
  check('点击后网格子项仍是 1 个（文件行保持整行宽）', childrenOf(files[0]).filter((child) => child && child.isElement === true).length === 1,
    String(childrenOf(files[0]).filter((child) => child && child.isElement === true).length))
  check('提示文字说明已在资源管理器中选中', textOf(status[0]).includes('已打开资源管理器并选中该文件'), textOf(status[0]))
}

/* 3. 音频 + 视频：网格里 2 个文件行，提示同样在网格外 */
{
  render({ meetingId: 'mt_mock', media: audioAndVideo })
  const tree = render({ meetingId: 'mt_mock', media: audioAndVideo })
  const revealButton = find(tree, (element) => element.type === 'button' && textOf(element).includes('查看目录'))[0]
  revealButton?.props?.onClick?.()
  await new Promise((resolve) => setTimeout(resolve, 40))
  const after = render({ meetingId: 'mt_mock', media: audioAndVideo })
  const files = byClass(after, 'dsm-files')
  check('音频+视频时网格有 2 个文件行', childrenOf(files[0]).filter((child) => child && child.isElement === true).length === 2)
  check('两行时提示也在网格外', find(files[0], (element) => typeof element.props?.className === 'string' && element.props.className.includes('dsm-file-status')).length === 0)
}

console.log('')
if (failures > 0) {
  console.error(`FAILED: ${failures} case(s)`)
  process.exit(1)
}
console.log('ALL FILE LAYOUT CHECKS PASSED')
