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
  '    globalThis.__TEST_HOOKS__ = { MeetingPanel, RecordModal, SettingsModal, ToastOverlay, MeetingGlyph, Toolbar, LiveRecordingBar, SpeechChip, MeetingList, CoverSection, SettingsModal, OnboardingModal }',
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
  ['OnboardingModal(missing ffmpeg)', hooks.OnboardingModal, { modelReady: false, todoReady: false, ffmpegReady: false, onClose() {}, onOpenSettings() {} }],
  ['OnboardingModal(ready)', hooks.OnboardingModal, { modelReady: true, todoReady: true, ffmpegReady: true, onClose() {}, onOpenSettings() {} }],
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

/* 回归：会议详情封面必须渲染会议标题（此前合并按钮行时误删 h1，标题整块消失） */
{
  try {
    const coverNode = hooks.CoverSection({
      meeting: { id: 'mt_regression', title: '回归用例：会议标题不能丢', date: '2026-11-13', attendees: [], transcript: '', transcriptSeconds: 0, media: [] },
      exporting: false,
      onEdit() {},
      onExport() {},
      onDelete() {},
    })
    let text = ''
    const collect = (node) => {
      if (node === null || node === undefined || typeof node === 'boolean') return
      if (typeof node === 'string' || typeof node === 'number') { text += String(node) + ' '; return }
      if (Array.isArray(node)) { for (const child of node) collect(child); return }
      if (typeof node === 'object' && node.props) collect(node.props.children)
    }
    collect(coverNode)
    if (text.includes('回归用例：会议标题不能丢')) {
      console.log('[OK] CoverSection 渲染会议标题')
    } else {
      failures += 1
      console.log('[FAIL] CoverSection 未渲染会议标题 →', text.slice(0, 100))
    }
  } catch (error) {
    failures += 1
    console.log('[FAIL] CoverSection 渲染异常 →', String(error?.message ?? error))
  }
}

/* 交互回归：录屏「识别」按钮改为行内转圈；冗余成功 toast 已收敛 */
{
  const checks = [
    ['录屏识别按钮有行内 loading', code.includes('identifyingScreen') && code.includes('dsm-spin--inline')],
    ['录屏识别不再弹成功 toast', !code.includes('notifySuccess(\'已在「')],
    ['冗余成功提示已移除（开始录屏/实时转写/音频转写）', !code.includes("notifySuccess('已开始录屏'") && !code.includes("notifySuccess('实时转写完成'") && !code.includes("notifySuccess('音频转写完成'")],
  ]
  for (const [label, ok] of checks) {
    if (ok) {
      console.log('[OK]', label)
    } else {
      failures += 1
      console.log('[FAIL]', label)
    }
  }
}

/* 交互回归：录音开始后不再弹「会议进行中」白色弹窗，直接交给桌面浮窗 / 页面录音条 */
{
  const checks = [
    ['开始录音成功后自动收起弹窗', code.includes('started === true) props.onClose()')],
    ['录音中再点入口只提示、不再打开发录音弹窗', code.includes("notify('info', '录音进行中'")],
  ]
  for (const [label, ok] of checks) {
    if (ok) {
      console.log('[OK]', label)
    } else {
      failures += 1
      console.log('[FAIL]', label)
    }
  }
}

/* 交互回归：桌面浮窗可切换音频输入设备（仅切换，不做电平检测） */
{
  const checks = [
    ['心跳带上输入设备列表与当前选择', code.includes('devices: Array.isArray(liveEngine.devices)') && code.includes('deviceId: selectedInputDeviceId')],
    ['浏览器能执行 switch-input 命令', code.includes("startsWith('switch-input:')") && code.includes('switchLiveInput')],
    ['切换设备后重新枚举设备（浮窗列表会刷新）', code.includes('refreshLiveInputDevices()')],
  ]
  for (const [label, ok] of checks) {
    if (ok) {
      console.log('[OK]', label)
    } else {
      failures += 1
      console.log('[FAIL]', label)
    }
  }
}

/* 交互回归：详情页有「整段重转写」入口，按 30 秒切片重识别并轮询进度 */
{
  const checks = [
    ['详情页提供整段重转写按钮', code.includes('整段重转写') && code.includes('onRetranscribe')],
    ['重转写会轮询后台进度', code.includes('startRetranscribe') && code.includes('/retranscribe') && code.includes('setInterval')],
  ]
  for (const [label, ok] of checks) {
    if (ok) {
      console.log('[OK]', label)
    } else {
      failures += 1
      console.log('[FAIL]', label)
    }
  }
}

/* 交互回归：决策只在「AI 会议纪要」卡片里展示，不再有单独的「决策清单」模块 */
{
  const checks = [
    ['单独决策清单模块已移除', !code.includes("title: '决策清单'") && !code.includes('dsm-decision')],
    ['AI 会议纪要仍含决策事项', code.includes("'决策事项'") && code.includes('dsm-minutes-panel--decision')],
    ['AI 会议纪要展示详细结构（关键要点/章节/风险/待确认/发言人）', code.includes("blockHead('list'")
      && code.includes("'章节速览'") && code.includes('dsm-chapter-summary')
      && code.includes('dsm-minutes-panel--risk') && code.includes("blockHead('info'")
      && code.includes("'发言人总结'") && code.includes('dsm-minutes-speaker')],
    ['AI 会议纪要新版布局（摘要区/关键词/决策风险并排/计数）', code.includes('dsm-minutes-hero')
      && code.includes('dsm-minutes-keyword') && code.includes('dsm-minutes-split')
      && code.includes('dsm-minutes-block-count') && code.includes('dsm-minutes-level--high')],
  ]
  for (const [label, ok] of checks) {
    if (ok) {
      console.log('[OK]', label)
    } else {
      failures += 1
      console.log('[FAIL]', label)
    }
  }
}

/* 交互回归：录音电平长期过低时提示一次（远场/小音量是转写准确率下降的主因） */
{
  const ok = code.includes('麦克风声音偏小') && code.includes('lowLevelWarned') && code.includes('lowLevelTicks')
  if (ok) {
    console.log('[OK] 录音电平过低会提示检查麦克风')
  } else {
    failures += 1
    console.log('[FAIL] 录音电平过低会提示检查麦克风')
  }
}

/* 交互回归：待办支持选中后弃用/恢复，并可只重新生成待办 */
{
  const checks = [
    ['待办支持弃用（选中后操作）', code.includes('弃用（') && code.includes('onDropTodos')],
    ['弃用的待办从列表移除、底部可批量恢复', code.includes('visibleTodos') && code.includes('恢复全部弃用')],
    ['待办可单独重新生成', code.includes('重新生成待办') && code.includes('onRegenerateTodos')],
  ]
  for (const [label, ok] of checks) {
    if (ok) {
      console.log('[OK]', label)
    } else {
      failures += 1
      console.log('[FAIL]', label)
    }
  }
}

/* 交互回归：首次使用引导弹窗 + 标题栏不展示待办数字 */
{
  const checks = [
    ['首次使用有引导弹窗（转写模型 + 待办插件）', code.includes('OnboardingModal') && code.includes('ONBOARDING_STORAGE_KEY')
      && code.includes('准备语音转写模型') && code.includes('dsh-memory-evolve')],
    ['引导弹窗可直接去设置', code.includes('onOpenSettings') && code.includes('去下载 / 配置模型')],
    ['引导弹窗检查并提示安装 ffmpeg', code.includes('安装 ffmpeg（可选，建议）') && code.includes('winget install Gyan.FFmpeg') && code.includes('ffmpegReady')],
    ['ffmpeg 可用状态由宿主 /state 提供', code.includes('screen?.ffmpegReady')],
    ['问题反馈页有版本与更新入口（只提示不自动装）', code.includes('版本与更新') && code.includes('检查更新') && code.includes('/update-check?force=1') && code.includes('不会自动安装')],
    ['会议纪要标题栏不再显示数字徽标', !code.includes('pending > 99') && !code.includes("className: 'dsm-icon-dot'")],
  ]
  for (const [label, ok] of checks) {
    if (ok) {
      console.log('[OK]', label)
    } else {
      failures += 1
      console.log('[FAIL]', label)
    }
  }
}

/* 交互回归：转写引擎可辨认 + 腾讯云标记开发中并排最后 */
{
  const checks = [
    ['设置页显示当前使用的转写引擎', code.includes('当前使用：') && code.includes('transcribeEngineLabel')],
    ['录音弹窗显示本次转写引擎', code.includes('本次转写引擎：')],
    ['录音弹窗提示先告知参会人（合规）', code.includes('录音 / 录屏前请先告知参会人并取得同意') && code.includes('涉密会议请只用本地模型')],
    ['云端 Tab 顺序为 讯飞→阿里云→腾讯云，且腾讯云标记开发中', code.includes("['iflytek', '讯飞'], ['aliyun', '阿里云'], ['tencent', '腾讯云']")
      && code.includes('开发中，暂不可用') && code.includes("key === 'tencent' ? h('span', { className: 'dsm-set-badge' }, '开发中')")],
  ]
  for (const [label, ok] of checks) {
    if (ok) {
      console.log('[OK]', label)
    } else {
      failures += 1
      console.log('[FAIL]', label)
    }
  }
}

/* 交互回归：会议录音/录屏文件并排展示 */
{
  const ok = code.includes('repeat(auto-fit,minmax(280px,1fr))')
    && code.includes('会议文件（音频/视频）行：录音与录屏并排展示')
    && code.includes('flex-flow:row wrap')
  if (ok) {
    console.log('[OK] 会议录音/录屏文件同一行展示（窄屏自动换行）')
  } else {
    failures += 1
    console.log('[FAIL] 会议录音/录屏文件同一行展示')
  }
}

console.log(failures === 0 ? '\nDEEP RENDER ALL PASSED (执行组件 ' + executed + ' 次)' : '\n' + failures + ' 个组件渲染失败');
process.exit(failures === 0 ? 0 : 1);
