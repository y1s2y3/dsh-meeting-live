import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.env.USERPROFILE, 'Desktop', 'dsh-meeting-minutes-src', 'src', 'lib', 'client.js');
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

const statePayload = {
  ok: true, now: new Date().toISOString(), today: '2026-11-13', clock: '16:50',
  autoIngest: { enabled: true, tencent: true, dirs: [], scanning: false, importedCount: 0, failedCount: 0, lastScanAt: '2026-11-13T08:00:00.000Z' },
  config: { llm: { provider: 'deepseek-official', model: 'deepseek-flash', label: 'DSH 默认模型' }, asr: { mode: 'local', providerId: 'paraformer-local', language: 'zh' } },
  speech: { available: true, selection: { providerId: 'paraformer-local', language: 'zh' }, providers: [] },
  transcribe: { provider: 'paraformer-local', ready: true, diarizationReady: true, correctTranscript: true },
  calendar: { ok: true, label: 'DSH 待办' },
  totals: { meetings: 0, todos: 0, pendingTodos: 0, summarized: 0 },
  meetings: [], storeFile: 'C:/store.json',
};
const settings = {
  transcribe: { provider: 'paraformer-local', cloud: { iflytek: {}, tencent: {}, aliyun: {} } },
  summary: { mode: 'dsh', custom: { baseUrl: '', apiKey: '', model: '', temperature: 0.3, maxTokens: 4000 } },
  terms: '', correctTranscript: true, diarize: true,
};
const modelsState = { dir: 'C:/models', assets: { paraformer: { installed: true, ready: true, bytes: 1, files: [] }, segmentation: { installed: true, ready: true, bytes: 1, files: [] }, campplus: { installed: true, ready: true, bytes: 1, files: [] } }, downloading: null };

globalThis.React = React;
globalThis.window = {
  __ModuleLoader__: { load: (opts) => { globalThis.__captured = opts; } },
  setInterval: () => 0, clearInterval: () => {},
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id),
  addEventListener() {}, removeEventListener() {}, location: { origin: 'http://localhost', pathname: '/' },
};
globalThis.document = {
  addEventListener() {}, removeEventListener() {},
  createElement: () => ({ style: {}, dataset: {}, click() {}, remove() {}, setAttribute() {}, appendChild() {} }),
  body: { appendChild() {}, removeChild() {} }, head: { appendChild() {} },
  querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
  documentElement: { style: {}, setAttribute() {} }, visibilityState: 'visible',
};
try {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', clipboard: { writeText: async () => {} }, mediaDevices: { getUserMedia: async () => { throw new Error('no mic') }, enumerateDevices: async () => [] } }, configurable: true, writable: true });
} catch { }
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 };
globalThis.fetch = async (url) => {
  const text = String(url);
  let body = statePayload;
  if (text.includes('/settings')) {
    const useCloud = globalThis.__SETTINGS_MODE__ === 'cloud';
    const settingsPayload = useCloud
      ? {
        ...settings,
        transcribe: { provider: 'cloud-iflytek', cloud: { iflytek: { appId: 'app', apiKey: 'key', apiSecret: 'secret' }, tencent: {}, aliyun: {} } },
        summary: { mode: 'custom', custom: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x', model: 'demo', temperature: 0.3, maxTokens: 4000 } },
      }
      : settings;
    body = { ok: true, settings: settingsPayload, terms: [], models: [], model: null, modelsState, transcribeProviders: [], cloudProviders: [] };
  }
  else if (text.includes('/models/status')) body = { ok: true, state: modelsState };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};
globalThis.location = globalThis.window.location;

const hookAnchor = '    exports.apply = apply';
code = code.replace(hookAnchor, [
  '    globalThis.__TEST_HOOKS__ = { MeetingPanel, RecordModal, SettingsModal, ToastOverlay, MeetingGlyph, Toolbar, LiveRecordingBar, SpeechChip, MeetingList, CoverSection, SettingsModal }',
  hookAnchor,
].join(String.fromCharCode(10)));
(0, eval)(code);
globalThis.__captured.factory((name) => { if (name === 'react') return React; throw new Error('unexpected require: ' + name); });
const hooks = globalThis.__TEST_HOOKS__;

/* 深度渲染：执行所有函数子组件，捕获未定义变量这类只在渲染时暴露的错误 */
let executed = 0;
function deepRender(node, depth, name) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') return;
  if (Array.isArray(node)) { node.forEach((child) => deepRender(child, depth, name)); return; }
  if (typeof node !== 'object' || node.isElement !== true) return;
  const { type, props } = node;
  if (typeof type === 'function') {
    if (depth > 12) return;
    let rendered;
    try {
      rendered = type(props ?? {});
    } catch (error) {
      throw new Error('子组件 ' + (type.name || 'anonymous') + ' 渲染失败: ' + (error?.message ?? error));
    }
    executed += 1;
    deepRender(rendered, depth + 1, name);
    return;
  }
  deepRender(props?.children, depth + 1, name);
}

const fakeState = {
  status: 'ready', data: statePayload, meetings: [], selectedId: null, meeting: null,
  speech: statePayload.speech, live: null, toasts: [], error: null,
  summarizing: null, exporting: null, dialog: null,
};

const cases = [
  ['MeetingPanel', hooks.MeetingPanel, {}],
  ['RecordModal(record)', hooks.RecordModal, { initialTab: 'record', onClose() {}, onOpenTextImport() {}, onSummarize() {} }],
  ['RecordModal(file)', hooks.RecordModal, { initialTab: 'file', onClose() {}, onOpenTextImport() {}, onSummarize() {} }],
  ['SettingsModal', hooks.SettingsModal, { status: statePayload.autoIngest, onClose() {}, onSelectMeeting() {} }],
  ['Toolbar(refreshing=false)', hooks.Toolbar, { state: fakeState, handlers: { refresh() {}, settings() {} }, refreshing: false }],
  ['Toolbar(refreshing=true)', hooks.Toolbar, { state: fakeState, handlers: { refresh() {}, settings() {} }, refreshing: true }],
  ['ToastOverlay', hooks.ToastOverlay, {}],
  ['MeetingGlyph', hooks.MeetingGlyph, {}],
  ['SpeechChip', hooks.SpeechChip, {}],
];

const sleep = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

let failures = 0;
for (const [name, component, props] of cases) {
  hookIndex = 0;
  hookStates.length = 0;
  try {
    const element = component(props);
    deepRender(element, 0, name);
    console.log('[OK]', name);
  } catch (error) {
    failures += 1;
    console.log('[FAIL]', name, '→', error?.message);
    console.log((error?.stack ?? '').split('\n').slice(1, 5).join('\n'));
  }
}
/* 云端 + 手动总结分支：先渲染一次触发加载，等设置回来后复用 hook 状态再渲染 */
globalThis.__SETTINGS_MODE__ = 'cloud';
hookIndex = 0;
hookStates.length = 0;
try {
  hooks.SettingsModal({ status: statePayload.autoIngest, onClose() {}, onSelectMeeting() {} });
  await sleep(120);
  const cloudElement = hooks.SettingsModal({ status: statePayload.autoIngest, onClose() {}, onSelectMeeting() {} });
  deepRender(cloudElement, 0, 'SettingsModal(cloud)');
  console.log('[OK] SettingsModal(cloud+custom)');
} catch (error) {
  failures += 1;
  console.log('[FAIL] SettingsModal(cloud+custom) →', error?.message);
  console.log((error?.stack ?? '').split('\n').slice(1, 5).join('\n'));
}

console.log(failures === 0 ? '\nDEEP RENDER ALL PASSED (执行组件 ' + executed + ' 次)' : '\n' + failures + ' 个组件渲染失败');
process.exit(failures === 0 ? 0 : 1);
