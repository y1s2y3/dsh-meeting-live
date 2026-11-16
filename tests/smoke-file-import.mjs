import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'src', 'lib', 'client.js');
let code = fs.readFileSync(file, 'utf8');

const hookStates = [];
let hookIndex = 0;
const React = {
  Component: class Component {
    constructor(props) { this.props = props; this.state = {}; }
    setState(update) {
      const next = typeof update === 'function' ? update(this.state) : update;
      this.state = { ...this.state, ...(next ?? {}) };
    }
  },
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length === 0 ? undefined : (children.length === 1 ? children[0] : children) }, isElement: true };
  },
  useState(init) {
    const index = hookIndex++;
    if (!(index in hookStates)) hookStates[index] = typeof init === 'function' ? init() : init;
    return [hookStates[index], (value) => { hookStates[index] = typeof value === 'function' ? value(hookStates[index]) : value; }];
  },
  useEffect(fn) { try { const clean = fn(); return typeof clean === 'function' ? clean : undefined; } catch { return undefined; } },
  useRef(init) { return { current: init }; },
  useCallback(fn) { return fn; },
  useMemo(fn) { return fn(); },
  Fragment: 'Fragment',
};

globalThis.React = React;
globalThis.window = {
  __ModuleLoader__: { load: (opts) => { globalThis.__captured = opts; } },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  addEventListener() {},
  removeEventListener() {},
  location: { origin: 'http://localhost', pathname: '/' },
};
globalThis.document = {
  addEventListener() {}, removeEventListener() {},
  createElement: () => ({ style: {}, click() {}, remove() {}, setAttribute() {} }),
  body: { appendChild() {}, removeChild() {} }, head: { appendChild() {} },
  querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
  documentElement: { style: {}, setAttribute() {} },
  visibilityState: 'visible',
};
try {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', clipboard: { writeText: async () => {} }, mediaDevices: { getUserMedia: async () => { throw new Error('no mic') }, enumerateDevices: async () => [] } }, configurable: true, writable: true });
} catch { }
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, state: { meetings: [], speech: null }, speech: null }), text: async () => '' });
globalThis.location = globalThis.window.location;

const hookAnchor = '    exports.apply = apply';
if (!code.includes(hookAnchor)) { console.log('MISS hook anchor'); process.exit(1); }
code = code.replace(hookAnchor, `    globalThis.__TEST_HOOKS__ = { RecordModal, buildTitleFromFileName }\n${hookAnchor}`);

const requireStub = (name) => { if (name === 'react') return React; throw new Error('unexpected require: ' + name); };
(0, eval)(code);
const exportsObject = globalThis.__captured.factory(requireStub);
const hooks = globalThis.__TEST_HOOKS__;

function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return; }
  if (typeof node !== 'object' || node.isElement !== true) return;
  visit(node);
  walk(node.props?.children, visit);
}

let failures = 0;
function check(label, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ← ' + detail}`);
  if (!condition) failures += 1;
}

const element = hooks.RecordModal({ initialTab: 'file', onClose() {}, onOpenTextImport() {}, onSummarize() {} });
const texts = [];
walk(element, (node) => {
  const kids = node.props?.children;
  const flat = Array.isArray(kids) ? kids : [kids];
  for (const child of flat) if (typeof child === 'string') texts.push(child);
});

check('录音转写：未选文件时不显示标题输入框', !texts.some((text) => text.includes('会议标题')), JSON.stringify(texts.slice(0, 6)));
check('录音转写：先选文件并提示标题自动生成', texts.some((text) => text.includes('先选文件')), '');
check('录音转写：文件选择按钮存在', texts.some((text) => text.includes('选择音频 / 视频文件')), '');

check('标题解析：去时间戳与下划线', hooks.buildTitleFromFileName('产品评审会议_20261113-1430.m4a') === '产品评审会议', hooks.buildTitleFromFileName('产品评审会议_20261113-1430.m4a'));
check('标题解析：最多 40 字', hooks.buildTitleFromFileName('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十多余的字符.mp3').length === 40, '');
check('标题解析：纯时间戳回退默认标题', hooks.buildTitleFromFileName('会议录音-20261113-1247.wav').includes('录音纪要'), hooks.buildTitleFromFileName('会议录音-20261113-1247.wav'));

console.log(failures === 0 ? '\nALL FILE IMPORT CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
