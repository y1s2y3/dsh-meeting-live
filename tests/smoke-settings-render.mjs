import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.env.USERPROFILE, 'Desktop', 'dsh-meeting-minutes-src', 'src', 'lib', 'client.js');
let code = fs.readFileSync(file, 'utf8');

/* 最小 React 垫片 */
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

/* 全局垫片 */
globalThis.React = React;
globalThis.window = {
  __ModuleLoader__: { load: (opts) => { globalThis.__captured = opts; } },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: (fn) => { void fn; return 0; },
  addEventListener() {},
  removeEventListener() {},
  location: { origin: 'http://localhost', pathname: '/' },
};
globalThis.document = {
  addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, click() {}, remove() {}, setAttribute() {} }),
  body: { appendChild() {}, removeChild() {} }, head: { appendChild() {} },
  querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
  documentElement: { style: {}, setAttribute() {} },
};
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', clipboard: { writeText: async () => {} }, mediaDevices: { getUserMedia: async () => { throw new Error('no mic') }, enumerateDevices: async () => [] } }, configurable: true, writable: true }); } catch { }
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, settings: {}, models: [], modelsState: null, autoIngest: {} }), text: async () => '' });
globalThis.location = globalThis.window.location;
globalThis.requestAnimationFrame = (fn) => { void fn; return 0; };

const hookAnchor = '    exports.apply = apply';
if (!code.includes(hookAnchor)) throw new Error('hook anchor not found');
code = code.replace(hookAnchor, `    globalThis.__TEST_HOOKS__ = { SettingsModal, RecordModal, MeetingList, CoverSection }\n${hookAnchor}`);

const requireStub = (name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
};
(0, eval)(code);
const captured = globalThis.__captured;
const exportsObject = captured.factory(requireStub);
const hooks = globalThis.__TEST_HOOKS__;
console.log('导出 hooks:', Object.keys(hooks).join(', '));

function renderWithEffects(component, props) {
  hookIndex = 0;
  for (let i = 0; i < hookStates.length; i += 1) hookStates[i] = undefined;
  return component(props);
}

try {
  const element = renderWithEffects(hooks.SettingsModal, {
    status: { enabled: true, tencent: true, dirs: [], scanning: false, importedCount: 0, failedCount: 0 },
    onClose() {},
    onSelectMeeting() {},
  });
  console.log('渲染成功，根元素:', element?.type, Object.keys(element?.props ?? {}).join(','));
} catch (error) {
  console.log('渲染抛错:', error?.message);
  console.log((error?.stack ?? '').split('\n').slice(0, 6).join('\n'));
}
