import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'src', 'lib', 'client.js');
let code = fs.readFileSync(file, 'utf8');

/* 反馈页图片交互回归：必须走页内灯箱，不能 window.open 跳浏览器新标签 */
{
  const hasLightbox = code.includes('dsm-lightbox') && code.includes('openLightbox')
  const opensNewTab = /window\.open\(\s*API \+ '\/assets/.test(code)
  if (hasLightbox && !opensNewTab) {
    console.log('[OK] 反馈页图片使用页内灯箱（不跳浏览器）')
  } else {
    console.log('[FAIL] 反馈页图片仍会跳浏览器或缺少灯箱:', JSON.stringify({ hasLightbox, opensNewTab }))
    process.exitCode = 1
  }
}

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

function check(name, passed, detail) {
  if (passed) {
    console.log('[OK] ' + name);
  } else {
    process.exitCode = 1;
    console.log('[FAIL] ' + name + (detail === undefined ? '' : ' → ' + JSON.stringify(detail)));
  }
}

/** 收集元素树里的文字（不需要执行子组件：这些文案都在 children 里）。 */
function collectText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node) + ' ';
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (typeof node !== 'object') return '';
  return collectText(node.props?.children);
}

try {
  const modalProps = {
    status: { enabled: true, tencent: true, dirs: [], scanning: false, importedCount: 0, failedCount: 0 },
    onClose() {},
    onSelectMeeting() {},
  };
  const element = renderWithEffects(hooks.SettingsModal, modalProps);
  console.log('渲染成功，根元素:', element?.type, Object.keys(element?.props ?? {}).join(','));

  /* 回归：设置弹窗四页统一宽度（跟随「问题反馈」页的 xwide），切页时不再忽宽忽窄 */
  check('设置弹窗使用 xwide 统一宽度', element?.props?.extraWide === true, element?.props?.extraWide);
  check('设置弹窗不再走 660px 的 wide 宽度', element?.props?.wide === undefined, element?.props?.wide);
  check('设置弹窗有独立的「转写纠错」菜单', code.includes("nav-correct") && code.includes("'转写纠错'") && code.includes("page === 'correct' ? correctPage"));
  // 宽度不能跟着当前页变：把 page 状态依次改成 correct / auto / feedback 再渲染，宽度必须保持
  let feedbackElement = null
  for (const pageKey of ['correct', 'auto', 'feedback']) {
    hookStates[0] = pageKey;
    hookIndex = 0;
    const pageElement = hooks.SettingsModal(modalProps);
    if (pageKey === 'feedback') feedbackElement = pageElement
    check('切到「' + pageKey + '」页后宽度仍是 xwide', pageElement?.props?.extraWide === true, pageElement?.props?.extraWide);
  }
  check('源码不再把宽度绑在当前页上', !code.includes("extraWide: page === 'feedback'"));

  /* 回归：会议室收音设备这件事必须写在「问题反馈」页的常见问题里 */
  const feedbackText = collectText(feedbackElement)
  check('问题反馈页写着会议室要连接收音设备', feedbackText.includes('收音设备'));
  check('问题反馈页给了具体设备建议（USB 全向麦 / line-out）', feedbackText.includes('USB 全向会议麦克风') && feedbackText.includes('line-out'));
} catch (error) {
  process.exitCode = 1;
  console.log('渲染抛错:', error?.message);
  console.log((error?.stack ?? '').split('\n').slice(0, 6).join('\n'));
}
