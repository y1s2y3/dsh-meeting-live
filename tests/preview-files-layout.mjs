/**
 * 视觉预览：会议文件行在「只有音频」时点过「查看目录」后的样子（验证不会变成半宽）。
 * 用法：node tests/preview-files-layout.mjs
 * 产物：browser-screenshots/preview-files-layout.html
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const installedDir = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-meeting-live')
const pluginDir = process.argv[2] ?? (fs.existsSync(path.join(repoRoot, 'src', 'lib', 'client.js')) ? path.join(repoRoot, 'src') : installedDir)
const clientFile = path.join(pluginDir, 'lib', 'client.js')
const outFile = path.join(repoRoot, 'browser-screenshots', 'preview-files-layout.html')
const source = fs.readFileSync(clientFile, 'utf8')
const cssMatch = source.match(/const CSS = `([\s\S]*?)`\s*\n\s*const STYLE_TAG_ID/)
if (cssMatch === null) throw new Error('CSS block not found')
const css = cssMatch[1]

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
  Component: class { constructor(props) { this.props = props; this.state = {} } setState() {} },
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
  createElement: () => ({ setAttribute() {}, appendChild() {}, style: {} }),
  head: { appendChild() {} }, body: { appendChild() {} }, addEventListener() {}, removeEventListener() {}, hidden: false,
}
const fakeWindow = {
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
  addEventListener() {}, removeEventListener() {}, location: { origin: 'http://127.0.0.1:43120' },
  __ModuleLoader__: { load: (options) => { globalThis.__captured = options } },
}
globalThis.window = fakeWindow
globalThis.document = fakeDocument
try { Object.defineProperty(globalThis, 'navigator', { value: { clipboard: null }, configurable: true, writable: true }) } catch { globalThis.navigator = { clipboard: null } }
globalThis.fetch = async () => ({ ok: true, status: 200, async json() { return { ok: true, revealed: true, opened: true } }, async text() { return '{}' } })

let code = source.replace('    exports.apply = apply', '    globalThis.__TEST_HOOKS__ = { MeetingFiles }\n    exports.apply = apply')
;(0, eval)(code)
globalThis.__captured.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
const { MeetingFiles } = globalThis.__TEST_HOOKS__

const camelToKebab = (name) => name.replace(/[A-Z]/g, (char) => '-' + char.toLowerCase())
const escapeHtml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const styleToCss = (style) => (style === null || typeof style !== 'object' ? '' : Object.entries(style).map(([key, value]) => `${camelToKebab(key)}:${value}`).join(';'))
function toHtml(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(toHtml).join('')
  if (typeof node !== 'object' || node.isElement !== true) return ''
  if (node.type === Fragment) return toHtml(node.props?.children)
  if (typeof node.type === 'function') return toHtml(node.type(node.props ?? {}))
  const props = node.props ?? {}
  const attrs = []
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || key === 'key' || key === 'ref' || typeof value === 'function') continue
    if (key === 'className') { attrs.push(`class="${escapeHtml(value)}"`); continue }
    if (key === 'style') { const style = styleToCss(value); if (style !== '') attrs.push(`style="${escapeHtml(style)}"`); continue }
    if (value === true) { attrs.push(key); continue }
    if (value === false || value === null || value === undefined) continue
    attrs.push(`${key}="${escapeHtml(value)}"`)
  }
  return `<${node.type}${attrs.length ? ' ' + attrs.join(' ') : ''}>${toHtml(props.children)}</${node.type}>`
}

const audioOnly = [{ kind: 'audio', name: '会议录音-20261117-1725.wav', bytes: 148000000, seconds: 4655 }]
const both = [
  { kind: 'audio', name: '会议录音-20261117-1725.wav', bytes: 148000000, seconds: 4655 },
  { kind: 'video', name: '会议录音-20261117-1725.mp4', bytes: 200000000, seconds: 4655 },
]
async function renderAfterReveal(media) {
  hookCursor = 0
  MeetingFiles({ meetingId: 'mt_mock', media })
  hookCursor = 0
  const tree = MeetingFiles({ meetingId: 'mt_mock', media })
  const buttons = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node !== 'object' || node.isElement !== true) return
    if (node.type === 'button') buttons.push(node)
    walk(node.props?.children)
  }
  walk(tree)
  const reveal = buttons.find((button) => JSON.stringify(button.props?.children ?? '').includes('查看目录'))
  reveal?.props?.onClick?.()
  await new Promise((resolve) => setTimeout(resolve, 40))
  hookCursor = 0
  return toHtml(MeetingFiles({ meetingId: 'mt_mock', media }))
}

const audioHtml = await renderAfterReveal(audioOnly)
const bothHtml = await renderAfterReveal(both)
const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><title>会议文件行布局预览</title>
<style>
html,body{margin:0;background:#F4F6FA;font-family:"Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif}
.wrap{width:900px;margin:0 auto;padding:18px 0 30px}
.case{margin-bottom:18px}
.label{font-size:12px;color:#64748B;margin:0 0 6px 2px;font-weight:600}
.surface{background:#FFFFFF;border:1px solid #E9EEF6;border-radius:14px;padding:12px}
${css}
</style></head><body><div class="wrap">
<div class="case"><div class="label">① 只有音频 · 点过「查看目录」后（文件行仍是整行宽，提示在下方）</div><div class="surface"><div class="dsm-root">${audioHtml}</div></div></div>
<div class="case"><div class="label">② 音频 + 视频 · 点过「查看目录」后（两行并排，提示在下方）</div><div class="surface"><div class="dsm-root">${bothHtml}</div></div></div>
</div></body></html>`
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, page, 'utf8')
console.log(outFile)
