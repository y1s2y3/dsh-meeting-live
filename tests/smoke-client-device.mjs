/**
 * 离线冒烟测试：在 Node 里用桩环境执行会议纪要插件的浏览器 bundle，
 * 验证本地补丁（设备选择 / 设备回退 / 录音弹窗 UI）真的生效。
 * 只读被补丁后的 client.js，不改任何文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const file = path.join(
  os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules',
  'dsh-plugin-meeting-minutes', 'lib', 'client.js',
);

/* ── 1. 桩 React ─────────────────────────────────────────────────────── */
const Fragment = Symbol('Fragment');
function createElement(type, props, ...children) {
  const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
  const next = props === null || props === undefined ? {} : { ...props };
  if (flat !== undefined) next.children = flat;
  return { type, props: next, isElement: true };
}
/* 迷你运行时：支持 useState 持久化 + useEffect 执行 + 状态变化后重渲染（够测一次弹窗渲染） */
let hookCursor = 0;
let hookStates = [];
let hookRefs = [];
let pendingEffects = [];
let runtimeDirty = false;
const React = {
  Component: class Component {
    constructor(props) { this.props = props; this.state = {}; }
    setState(update) {
      const next = typeof update === 'function' ? update(this.state) : update;
      this.state = { ...this.state, ...(next ?? {}) };
    }
  },
  createElement,
  Fragment,
  useState(init) {
    const index = hookCursor;
    hookCursor += 1;
    if (!(index in hookStates)) hookStates[index] = typeof init === 'function' ? init() : init;
    return [hookStates[index], (value) => {
      hookStates[index] = typeof value === 'function' ? value(hookStates[index]) : value;
      runtimeDirty = true;
    }];
  },
  useEffect: (fn) => { pendingEffects.push(fn); },
  useLayoutEffect: (fn) => { pendingEffects.push(fn); },
  useMemo: (fn) => fn(),
  useRef(value) {
    const index = hookCursor;
    hookCursor += 1;
    if (!(index in hookRefs)) hookRefs[index] = { current: value };
    return hookRefs[index];
  },
  useCallback: (fn) => fn,
  useContext: () => null,
  memo: (component) => component,
};
async function renderWithEffects(component, props) {
  hookCursor = 0;
  let element = component(props);
  const effects = pendingEffects;
  pendingEffects = [];
  for (const effect of effects) effect();
  for (let pass = 0; pass < 4; pass += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (!runtimeDirty) break;
    runtimeDirty = false;
    hookCursor = 0;
    element = component(props);
    pendingEffects = [];
  }
  return element;
}

/* ── 2. DOM / 浏览器桩 ───────────────────────────────────────────────── */
const styleNodes = [];
const fakeDocument = {
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, dataset: {}, textContent: '' }),
  head: { appendChild: (node) => styleNodes.push(node) },
  body: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
};
const store = new Map();
const fakeLocalStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: (key) => { store.delete(key); },
};
const mediaCalls = [];
let mediaBehaviour = 'ok';
const fakeNavigator = {
  mediaDevices: {
    enumerateDevices: async () => [
      { kind: 'audioinput', deviceId: 'dev-1', label: '麦克风 (Realtek)' },
      { kind: 'audioinput', deviceId: '', label: '' },
      { kind: 'videoinput', deviceId: 'cam-1', label: '摄像头' },
    ],
    getUserMedia: async (constraints) => {
      mediaCalls.push(constraints);
      const wantsExact = Boolean(constraints?.audio?.deviceId?.exact);
      if (mediaBehaviour === 'deny-exact' && wantsExact) {
        const error = new Error('constraint failed');
        error.name = 'OverconstrainedError';
        throw error;
      }
      return { getTracks: () => [{ stop() {} }], getAudioTracks: () => [] };
    },
    addEventListener() {},
    removeEventListener() {},
  },
};
class FakeAudioContext {
  constructor() {
    this.sampleRate = 16000;
    this.state = 'running';
    this.destination = { connect() {} };
  }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; }
  createGain() { return { connect() {}, disconnect() {}, gain: { value: 1 } }; }
  async resume() { this.state = 'running'; }
  close() {}
}
const fakeWindow = {
  localStorage: fakeLocalStorage,
  AudioContext: FakeAudioContext,
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  addEventListener() {},
  removeEventListener() {},
  location: { origin: 'http://127.0.0.1:43120' },
  __ModuleLoader__: { load: (options) => { globalThis.__captured = options; } },
};
const fetchCalls = [];
const fakeFetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  const body = String(url).includes('/state')
    ? { ok: true, meetings: [], autoIngest: null, speech: { available: true, providers: [{ id: 'sensevoice-local', phase: 'ready' }], selection: { providerId: 'sensevoice-local', language: 'zh' } } }
    : { ok: true };
  return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } };
};

globalThis.window = fakeWindow;
globalThis.document = fakeDocument;
try {
  Object.defineProperty(globalThis, 'navigator', { value: fakeNavigator, configurable: true, writable: true });
} catch {
  globalThis.navigator = fakeNavigator;
}
globalThis.fetch = fakeFetch;
globalThis.localStorage = fakeLocalStorage;

/* ── 3. 执行 bundle（只在内存里注入测试钩子，不落盘）────────────────── */
let code = fs.readFileSync(file, 'utf8');
const hookAnchor = '    exports.apply = apply';
if (!code.includes(hookAnchor)) {
  console.log('FAIL: 找不到 exports.apply 锚点');
  process.exit(1);
}
code = code.replace(hookAnchor, `    globalThis.__TEST_HOOKS__ = {
      buildTitleFromFileName,
      RecordModal,
      openLiveCapture,
      listAudioInputDevices,
      readSelected: () => selectedInputDeviceId,
      writeSelected: (value) => { selectedInputDeviceId = value; writePreferredInputDevice(value); },
    }
${hookAnchor}`);

const requireStub = (name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
};
(0, eval)(code);

const captured = globalThis.__captured;
if (!captured || typeof captured.factory !== 'function') {
  console.log('FAIL: __ModuleLoader__.load 未被调用');
  process.exit(1);
}
const exportsObj = captured.factory(requireStub);
const hooks = globalThis.__TEST_HOOKS__;
console.log('module loaded:', Object.keys(exportsObj).join(','), '| hooks:', Object.keys(hooks).join(','));

/* ── 4. 启插件体（slots/effect 桩）───────────────────────────────────── */
const registered = [];
const fakeCtx = {
  slots: {
    inject: (_name, fn) => fn(),
    register: (meta, component) => { registered.push({ meta, component }); },
  },
  effect: (fn) => { fn(); },
  layout: {},
};
exportsObj.apply(fakeCtx);
await new Promise((resolve) => setTimeout(resolve, 30));
console.log('registered slots:', registered.map((entry) => entry.meta.name).join(','));

let failures = 0;
const check = (label, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ← ' + detail}`);
  if (!condition) failures += 1;
};

/* ── 5. 设备枚举 ────────────────────────────────────────────────────── */
const devices = await hooks.listAudioInputDevices();
check('枚举输入设备并过滤空 deviceId', devices.length === 1 && devices[0].deviceId === 'dev-1', JSON.stringify(devices));

/* ── 6. getUserMedia 带所选设备 ─────────────────────────────────────── */
hooks.writeSelected('dev-1');
mediaCalls.length = 0;
const capture = await hooks.openLiveCapture();
check('选中设备时传入 deviceId.exact', mediaCalls.length === 1 && mediaCalls[0].audio.deviceId?.exact === 'dev-1', JSON.stringify(mediaCalls[0]?.audio));
check('保留降噪/单声道约束', mediaCalls[0]?.audio?.channelCount === 1 && mediaCalls[0]?.audio?.noiseSuppression === true);
check('返回采集资源', Boolean(capture && capture.stream && capture.processor), Object.keys(capture ?? {}).join(','));

/* ── 7. 所选设备不可用时回退默认 ───────────────────────────────────── */
mediaCalls.length = 0;
mediaBehaviour = 'deny-exact';
hooks.writeSelected('dev-1');
const fallbackCapture = await hooks.openLiveCapture();
check('设备失效时回退系统默认（不再传 deviceId）', mediaCalls.length === 2 && mediaCalls[1].audio.deviceId === undefined, `calls=${mediaCalls.length}`);
check('回退后清空已保存选择', hooks.readSelected() === '' && store.has('dsh-meeting-minutes:input-device') === false);
check('回退仍能拿到采集资源', Boolean(fallbackCapture && fallbackCapture.stream));
mediaBehaviour = 'ok';

/* ── 8. 录音弹窗渲染：设备下拉存在且选项正确 ────────────────────────── */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return; }
  if (typeof node !== 'object' || node.isElement !== true) return;
  visit(node);
  walk(node.props?.children, visit);
}
const recordElement = await renderWithEffects(hooks.RecordModal, { onClose() {}, onOpenTextImport() {}, onSummarize() {} });
const texts = [];
let deviceField = null;
let selectElement = null;
walk(recordElement, (element) => {
  if (typeof element.props?.label === 'string' && element.props.label.includes('麦克风')) deviceField = element;
  if (Array.isArray(element.props?.options)) selectElement = element;
  const children = element.props?.children;
  const flat = Array.isArray(children) ? children : [children];
  for (const child of flat) { if (typeof child !== 'string') continue; texts.push(child); if (child.includes('麦克风')) deviceField = element; }
});
check('录音弹窗出现「麦克风输入设备」字段', deviceField !== null);
check('渲染出设备下拉', selectElement !== null);
const options = selectElement ? selectElement.props.options : [];
const labels = options.map((option) => option.label);
check('下拉含「系统默认」+ 枚举到的设备', labels.length === 2 && labels[0] === '系统默认输入设备' && labels[1] === '麦克风 (Realtek)', JSON.stringify(labels));
check('提示文案说明设备选择会记住', texts.some((text) => text.includes('选择会记住')));
check('麦克风卡提供「检测」按钮', texts.some((text) => text === '检测'), JSON.stringify(texts.filter((text) => text.length <= 4)));


/* ── 9. 录音转写：先选文件、标题自动解析 ─────────────────────────── */
const fileElement = await renderWithEffects(hooks.RecordModal, { initialTab: 'file', onClose() {}, onOpenTextImport() {}, onSummarize() {} });
const fileTexts = [];
walk(fileElement, (element) => {
  const kids = element.props?.children;
  const flat = Array.isArray(kids) ? kids : [kids];
  for (const child of flat) if (typeof child === 'string') fileTexts.push(child);
});
check('标题解析：去掉时间戳与下划线', hooks.buildTitleFromFileName('产品评审会议_20261113-1430.m4a') === '产品评审会议', hooks.buildTitleFromFileName('产品评审会议_20261113-1430.m4a'));
check('标题解析：最多 40 字', hooks.buildTitleFromFileName('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十多余的字符.mp3').length === 40, '')
check('标题解析：纯时间戳文件名回退默认标题', hooks.buildTitleFromFileName('会议录音-20261113-1247.wav').includes('录音纪要'), hooks.buildTitleFromFileName('会议录音-20261113-1247.wav'));

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
