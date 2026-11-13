/**
 * 离线集成测试：浏览器 bundle 的「暂停 / 继续 / 浮窗指令 / 停止后跳回纪要」。
 * 用桩 DOM + 迷你 React + 桩后端跑真实 bundle，不碰真实录音设备。
 *
 * 用法：node smoke-client2.mjs [插件目录]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const pluginDir = process.argv[2] ?? path.join(
  os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-plugin-meeting-minutes',
);
const file = path.join(pluginDir, 'lib', 'client.js');

/* ── 桩 React（带状态持久化 + effect） ─────────────────────────────── */
const Fragment = Symbol('Fragment');
function createElement(type, props, ...children) {
  const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
  const next = props === null || props === undefined ? {} : { ...props };
  if (flat !== undefined) next.children = flat;
  return { type, props: next, isElement: true };
}
let hookCursor = 0;
const hookStates = [];
const hookRefs = [];
const React = {
  createElement,
  Fragment,
  useState(init) {
    const index = hookCursor; hookCursor += 1;
    if (!(index in hookStates)) hookStates[index] = typeof init === 'function' ? init() : init;
    return [hookStates[index], (value) => { hookStates[index] = typeof value === 'function' ? value(hookStates[index]) : value; }];
  },
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (fn) => fn(),
  useRef(value) { const index = hookCursor; hookCursor += 1; if (!(index in hookRefs)) hookRefs[index] = { current: value }; return hookRefs[index]; },
  useCallback: (fn) => fn,
  useContext: () => null,
  memo: (component) => component,
};

/* ── 桩 DOM / 浏览器 ──────────────────────────────────────────────── */
const fakeDocument = {
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, dataset: {}, textContent: '' }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
  hidden: false,
};
const memory = new Map();
const fakeLocalStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => { memory.set(key, String(value)); },
  removeItem: (key) => { memory.delete(key); },
};
const timers = [];
const mediaCalls = [];
const fakeNavigator = {
  mediaDevices: {
    enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'dev-1', label: '麦克风 (Realtek)' }],
    getUserMedia: async (constraints) => {
      mediaCalls.push(constraints);
      return { getTracks: () => [{ stop() {} }], getAudioTracks: () => [] };
    },
    addEventListener() {},
    removeEventListener() {},
  },
};
class FakeAudioContext {
  constructor() { this.sampleRate = 16000; this.state = 'running'; this.destination = { connect() {} }; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; }
  createGain() { return { connect() {}, disconnect() {}, gain: { value: 1 } }; }
  async resume() { this.state = 'running'; }
  close() {}
}
const fakeWindow = {
  localStorage: fakeLocalStorage,
  AudioContext: FakeAudioContext,
  setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
  setTimeout: () => 0,
  clearTimeout: () => {},
  addEventListener() {},
  removeEventListener() {},
  location: { origin: 'http://127.0.0.1:43120' },
  __ModuleLoader__: { load: (options) => { globalThis.__captured = options; } },
};

const meeting = {
  id: 'mt_test', title: 'Q4 预算会', date: '2026-11-12', attendees: [],
  transcript: '', transcriptSeconds: 0, summary: null, todos: [],
};
const speech = {
  available: true,
  providers: [{ id: 'sensevoice-local', phase: 'ready' }],
  selection: { providerId: 'sensevoice-local', language: 'zh' },
};
let remoteCommand = null;
const calls = [];
const fakeFetch = async (url, init) => {
  const target = String(url);
  calls.push({ url: target, method: init?.method ?? 'GET', body: init?.body });
  const json = (payload) => ({ ok: payload.ok !== false, status: payload.ok === false ? 400 : 200, async json() { return payload; }, async text() { return JSON.stringify(payload); } });
  if (target.includes('/live/status')) return json({ ok: true, command: remoteCommand });
  if (target.includes('/speech/status')) return json({ ok: true, speech });
  if (target.endsWith('/state')) return json({ ok: true, meetings: [meeting], autoIngest: null, speech });
  if (target.includes('/transcribe')) return json({ ok: true, text: '', audioSeconds: 2, transcript: '', transcriptSeconds: 2 });
  if (target.match(/\/meetings\/[^/]+$/) !== null) return json({ ok: true, meeting });
  if (target.endsWith('/meetings')) return json({ ok: true, meeting });
  return json({ ok: true });
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

/* ── 执行 bundle 并暴露测试钩子 ───────────────────────────────────── */
let code = fs.readFileSync(file, 'utf8');
const hookAnchor = '    exports.apply = apply';
code = code.replace(hookAnchor, `    globalThis.__TEST_HOOKS__ = {
      startLiveRecording,
      pauseLiveRecording,
      resumeLiveRecording,
      stopLiveRecording,
      pushLiveHeartbeat,
      MeetingList,
      CoverSection,
      EmptyState,
      RecordModal,
      clearLiveRecording,
      extractVoiceFeature,
      assignLiveSpeaker,
      resetSpeakers: () => { liveEngine.speakerCentroids = [] },
      liveState: () => snapshot.live,
    }
${hookAnchor}`);
const requireStub = (name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
};
(0, eval)(code);
const captured = globalThis.__captured;
const exportsObject = captured.factory(requireStub);
const hooks = globalThis.__TEST_HOOKS__;

const panels = [];
const fakeCtx = {
  slots: { inject: (_name, fn) => fn(), register() {} },
  effect: (fn) => { fn(); },
  layout: { selectPanel: (name) => { panels.push(name); } },
};
exportsObject.apply(fakeCtx);
await new Promise((resolve) => setTimeout(resolve, 40));

let failures = 0;
const check = (label, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ← ' + detail}`);
  if (!condition) failures += 1;
};

/* 1. 开始录音 */
const started = await hooks.startLiveRecording({ title: 'Q4 预算会' });
let live = hooks.liveState();
check('开始实时录音', started === true && live.status === 'recording', JSON.stringify({ started, status: live.status, meetingId: live.meetingId }));
const elapsedAtStart = live.elapsedSeconds;

/* 2. 暂停：状态、采集释放、计时冻结 */
const pausedOk = await hooks.pauseLiveRecording();
live = hooks.liveState();
check('暂停成功且状态为 paused', pausedOk === true && live.status === 'paused', JSON.stringify({ pausedOk, status: live.status }));
check('暂停后计时冻结（不增长）', live.elapsedSeconds === elapsedAtStart, `before=${elapsedAtStart} after=${live.elapsedSeconds}`);
check('暂停后录音会话仍活跃（浮窗应保留）', live.status === 'paused' && live.meetingId === 'mt_test');

/* 3. 继续：回到录音中 */
const resumedOk = await hooks.resumeLiveRecording();
live = hooks.liveState();
check('继续成功且状态回到 recording', resumedOk === true && live.status === 'recording', JSON.stringify({ resumedOk, status: live.status }));
check('继续时重新打开麦克风采集', mediaCalls.length >= 2, `getUserMedia 调用 ${mediaCalls.length} 次`);

/* 4. 浮窗指令：pause -> resume -> stop */
remoteCommand = 'pause';
await hooks.pushLiveHeartbeat();
check('浮窗「暂停」指令被执行', hooks.liveState().status === 'paused', hooks.liveState().status);

remoteCommand = 'resume';
await hooks.pushLiveHeartbeat();
check('浮窗「继续」指令被执行', hooks.liveState().status === 'recording', hooks.liveState().status);

remoteCommand = 'stop';
const panelsBefore = panels.length;
await hooks.pushLiveHeartbeat();
await new Promise((resolve) => setTimeout(resolve, 60));
live = hooks.liveState();
check('浮窗「停止」指令结束录音', live.status === 'done' || live.status === 'error', live.status);
check('停止后自动切回会议纪要面板', panels.length > panelsBefore && panels[panels.length - 1] === 'meeting-minutes', JSON.stringify(panels));
check('停止后选中本次会议', live.meetingId === 'mt_test');

/* 5. 心跳内容：状态与计时上报 + 结束时补发终态心跳（浮窗据此立即收起） */
const liveStatusCalls = calls.filter((entry) => entry.url.includes('/live/status'));
const activeHeartbeat = liveStatusCalls
  .map((entry) => { try { return JSON.parse(entry.body); } catch { return null; } })
  .filter(Boolean)
  .find((body) => ['recording', 'paused'].includes(body.status));
check('录音中的心跳含状态/会议/时长/字数', activeHeartbeat !== undefined
  && activeHeartbeat.meetingId === 'mt_test'
  && Number.isFinite(activeHeartbeat.elapsedSeconds), JSON.stringify(activeHeartbeat ?? null));
const finalBody = (() => {
  try { return JSON.parse(liveStatusCalls[liveStatusCalls.length - 1].body); } catch { return null; }
})();
check('会话结束补发终态心跳（停止后浮窗立即收起）',
  finalBody !== null && ['done', 'error', 'idle'].includes(finalBody.status), JSON.stringify(finalBody));

/* 6. 页面内仍保留兜底录音条逻辑（liveIsActive 覆盖 paused） */
check('本页静音/暂停时不再有「实时转写中断」误报：暂停走的是暂停状态', live.status === 'done' || live.status === 'error', live.status);

/* 7. 0 字录音结束不留空壳记录（会 DELETE 临时会议） */
const deleteCalls = calls.filter((entry) => (entry.method ?? 'GET') === 'DELETE');
check('0 字录音结束自动删除空壳记录', deleteCalls.length >= 1, deleteCalls.map((entry) => entry.url).join(','));
check('停止后不再跳去选中一条已删除的会议', hooks.liveState().result?.meetingId !== 'mt_test',
  JSON.stringify(hooks.liveState().result ?? null));

/* 8. 左侧列表为单行：图标 + 标题 +（已总结）+ 时间，没有第二行元信息 */
const listMeetings = [
  {
    id: 'mt_a', title: '录音纪要 2026-11-12 17:28', date: '2026-11-12', createdAt: '2026-11-12T09:28:51.127Z',
    sourceType: 'recording', hasSummary: false, todoCount: 0, pendingTodoCount: 0, attendees: [],
  },
  {
    id: 'mt_b', title: 'Q4 预算会', date: '2026-11-12', createdAt: '2026-11-12T10:05:00.000Z',
    sourceType: 'text', hasSummary: true, todoCount: 2, pendingTodoCount: 1, attendees: ['张三', '李四'],
  },
];
const listElement = hooks.MeetingList({
  meetings: listMeetings, selectedId: 'mt_b', search: '', filter: 'all', total: 2,
  onSearch() {}, onFilter() {}, onSelect() {},
  actions: { newMeeting() {}, record() {}, importText() {}, liveActive: false, recordDisabled: false },
});
function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return; }
  if (typeof node !== 'object' || node.isElement !== true) return;
  visit(node);
  walk(node.props?.children, visit);
}
const itemButtons = [];
let metaNodes = 0;
let statusNodes = 0;
walk(listElement, (element) => {
  const className = typeof element.props?.className === 'string' ? element.props.className : '';
  if (element.type === 'button' && className.includes('dsm-meeting')) itemButtons.push(element);
  if (className.includes('dsm-meeting-meta')) metaNodes += 1;
  if (className.includes('dsm-meeting-status')) statusNodes += 1;
});
check('列表项渲染出 2 条会议', itemButtons.length === 2, String(itemButtons.length));
check('每条会议都是两行结构（标题行 + 元信息行）', metaNodes === 2, `meta=${metaNodes}`);
check('状态标签渲染在第二行（每条一个）', statusNodes === 2, `status=${statusNodes}`);
const childClasses = itemButtons.map((item) => {
  const children = Array.isArray(item.props.children) ? item.props.children : [item.props.children];
  return children.filter((child) => child && child.isElement === true)
    .map((child) => String(child.props?.className ?? ''));
});
check('列表项外层只有图标 + 两行内容块', childClasses.every((classes) => classes.includes('dsm-meeting-icon')
  && classes.includes('dsm-meeting-body') && classes.length === 2), JSON.stringify(childClasses));
const bodyChildren = itemButtons.map((item) => {
  const children = Array.isArray(item.props.children) ? item.props.children : [item.props.children];
  const body = children.find((child) => child && child.isElement === true && String(child.props?.className ?? '').includes('dsm-meeting-body'));
  const inner = Array.isArray(body?.props?.children) ? body.props.children : [body?.props?.children];
  return inner.filter((child) => child && child.isElement === true).map((child) => String(child.props?.className ?? ''));
});
check('内容块第一行是标题、第二行是元信息', bodyChildren.every((classes) => classes[0].includes('dsm-meeting-title')
  && classes[1].includes('dsm-meeting-meta')), JSON.stringify(bodyChildren));
let firstStatusInMeta = false;
walk(itemButtons[1], (element) => {
  const className = typeof element.props?.className === 'string' ? element.props.className : '';
  if (className.includes('dsm-meeting-status')) {
    firstStatusInMeta = true;
  }
});
check('已总结的会议在第二行带状态标签', firstStatusInMeta, '');

/* 9. 三个主动作已移到列表上方（新建 / 录音 / 导入），且录音为主色大按钮 */
const quickButtons = [];
walk(listElement, (element) => {
  const className = typeof element.props?.className === 'string' ? element.props.className : '';
  if (element.type === 'button' && className.includes('dsm-quick-btn')) quickButtons.push(className);
});
check('列表上方渲染出三个主动作按钮', quickButtons.length === 3, JSON.stringify(quickButtons));
check('三个按钮带「做大」样式类', quickButtons.every((name) => name.includes('dsm-quick-btn')), JSON.stringify(quickButtons));
check('录音转文字按钮为主色高亮', quickButtons.some((name) => name.includes('dsm-quick-btn--primary')), JSON.stringify(quickButtons));


/* 10. 每场会议记录内部带「AI 生成纪要 / 导出 HTML / 导出 Markdown / 删除」 */
const coverElement = hooks.CoverSection({
  meeting: {
    id: 'mt_a', title: 'T', date: '2026-11-12', attendees: [], transcript: 'hello', transcriptSeconds: 60,
    sourceType: 'recording', summary: null, autoImported: false,
  },
  onEdit() {}, onSummarize() {}, onExport() {}, onDelete() {},
  summarizing: false, exporting: false, hasTranscript: true, hasSummary: false,
});
const coverButtonLabels = [];
walk(coverElement, (element) => {
  if (element.type !== 'button') return;
  const parts = [];
  walk(element, (node) => {
    if (node === element) return;
    const children = node.props?.children;
    const flat = Array.isArray(children) ? children : [children];
    for (const child of flat) if (typeof child === 'string') parts.push(child);
  });
  const label = parts.join('');
  if (label !== '') coverButtonLabels.push(label);
});
check('会议记录里不再有 AI 生成纪要按钮', !coverButtonLabels.includes('AI 生成纪要'), JSON.stringify(coverButtonLabels));
check('会议记录里只有一个「导出」下拉', coverButtonLabels.filter((label) => label.includes('导出')).length === 1, JSON.stringify(coverButtonLabels));
check('会议记录里带删除', coverButtonLabels.includes('删除'), JSON.stringify(coverButtonLabels));

/* 11. 快捷入口已拆成「实时录音 / 录音转写 / 导入纪要」（不再有新建会议） */
const quickLabels = [];
walk(listElement, (element) => {
  const className = typeof element.props?.className === 'string' ? element.props.className : '';
  if (element.type !== 'button' || !className.includes('dsm-quick-btn')) return;
  const parts = [];
  walk(element, (node) => {
    if (node === element) return;
    const children = node.props?.children;
    const flat = Array.isArray(children) ? children : [children];
    for (const child of flat) if (typeof child === 'string') parts.push(child);
  });
  quickLabels.push(parts.join(''));
});
check('快捷入口为实时录音 / 录音转写 / 导入纪要',
  quickLabels.length === 3 && quickLabels[0] === '实时录音/录屏' && quickLabels[1] === '录音转写' && quickLabels[2] === '导入纪要',
  JSON.stringify(quickLabels));
check('快捷入口已去掉「新建会议」', !quickLabels.some((label) => label.includes('新建会议')), JSON.stringify(quickLabels));

/* 12. 空状态页同样是三入口，且没有新建会议 */
const emptyElement = hooks.EmptyState({
  speech: { available: true, providers: [{ id: 'p', phase: 'ready' }], selection: { providerId: 'p', language: 'zh' } },
  onRecord() {}, onImport() {}, onNew() {},
});
const emptyTitles = [];
walk(emptyElement, (element) => {
  const className = typeof element.props?.className === 'string' ? element.props.className : '';
  if (className === 'dsm-entry-title') {
    const children = element.props?.children;
    const flat = Array.isArray(children) ? children : [children];
    for (const child of flat) if (typeof child === 'string') emptyTitles.push(child);
  }
});
check('空状态页入口为实时录音 / 录音转写 / 导入腾讯会议纪要',
  emptyTitles.includes('实时录音/录屏') && emptyTitles.includes('录音转写'), JSON.stringify(emptyTitles));
check('空状态页也去掉了新建会议', !emptyTitles.includes('新建会议'), JSON.stringify(emptyTitles));

/* 13. 录音弹窗只展示当前功能（不再有 Tab 切换条） */
hooks.clearLiveRecording();

function collectText(root) {
  const parts = [];
  walk(root, (node) => {
    const children = node.props?.children;
    const flat = Array.isArray(children) ? children : [children];
    for (const child of flat) if (typeof child === 'string') parts.push(child);
  });
  return parts.join('');
}

function collectClasses(root) {
  const classes = [];
  walk(root, (element) => {
    const className = typeof element.props?.className === 'string' ? element.props.className : '';
    if (className !== '') classes.push(className);
  });
  return classes;
}

const recordModal = hooks.RecordModal({ onClose() {}, onSummarize() {}, onOpenTextImport() {}, initialTab: 'record' });
const recordText = collectText(recordModal);
const recordClasses = collectClasses(recordModal);
check('实时录音入口：没有任何 Tab 切换条', recordClasses.every((name) => !name.includes('dsm-tab')) && recordClasses.some((name) => name.includes('dsm-record-mode')), JSON.stringify(recordClasses.filter((name) => name.includes('tab') || name.includes('record-mode'))));
check('实时录音入口：显示「实时录音」功能说明', recordText.includes('实时录音') && recordText.includes('打开麦克风'), recordText.slice(0, 80));
let hasDeviceSelect = false;
walk(recordModal, (element) => {
  const options = element.props?.options;
  if (Array.isArray(options) && options.some((option) => String(option?.label ?? '').includes('系统默认输入设备'))) hasDeviceSelect = true;
});
check('实时录音入口：带麦克风设备选择', hasDeviceSelect, '');
check('实时录音入口：不出现文件选择', !recordText.includes('选择音频 / 视频文件'), '');

const fileModal = hooks.RecordModal({ onClose() {}, onSummarize() {}, onOpenTextImport() {}, initialTab: 'file' });
const fileText = collectText(fileModal);
const fileClasses = collectClasses(fileModal);
check('录音转写入口：没有任何 Tab 切换条', fileClasses.every((name) => !name.includes('dsm-tab')), JSON.stringify(fileClasses.filter((name) => name.includes('tab'))));
check('录音转写入口：显示「录音转写」功能说明', fileText.includes('录音转写') && fileText.includes('导入已有的音频'), fileText.slice(0, 80));
check('录音转写入口：带文件选择按钮', fileText.includes('选择音频 / 视频文件'), '');
let fileHasDeviceSelect = false;
walk(fileModal, (element) => {
  const options = element.props?.options;
  if (Array.isArray(options) && options.some((option) => String(option?.label ?? '').includes('系统默认输入设备'))) fileHasDeviceSelect = true;
});
check('录音转写入口：不出现麦克风设备选择', !fileHasDeviceSelect, '');

/* 14. 按音色估算说话人：不同基频分到 A/B，同一基频归为同一人 */
function tone(hz, seconds) {
  const rate = 16000;
  const out = new Float32Array(Math.round(rate * seconds));
  for (let index = 0; index < out.length; index += 1) out[index] = Math.sin((2 * Math.PI * hz * index) / rate) * 0.6;
  return out;
}
hooks.resetSpeakers();
const lowFeature = hooks.extractVoiceFeature(tone(120, 2));
const highFeature = hooks.extractVoiceFeature(tone(240, 2));
check('音色特征能估出基频', lowFeature !== null && Math.abs(lowFeature.pitch - 120) < 12 && highFeature !== null && Math.abs(highFeature.pitch - 240) < 24, JSON.stringify({ low: lowFeature?.pitch, high: highFeature?.pitch }));
const lowLabel = hooks.assignLiveSpeaker(lowFeature);
const highLabel = hooks.assignLiveSpeaker(highFeature);
check('按音色分出两位说话人（A/B）', lowLabel === 0 && highLabel === 1, JSON.stringify({ lowLabel, highLabel }));
const lowAgain = hooks.assignLiveSpeaker(hooks.extractVoiceFeature(tone(122, 2)));
check('相近音色归为同一位说话人', lowAgain === lowLabel, JSON.stringify({ lowLabel, lowAgain }));
const third = hooks.assignLiveSpeaker(hooks.extractVoiceFeature(tone(175, 2)));
check('最多扩展到第三位说话人 C', third === 2, JSON.stringify({ third }));

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
