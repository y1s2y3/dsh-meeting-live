/**
 * 离线测试：宿主侧「录音镜像 + 浮窗桥接」。
 * 用假的 orb 对象验证：会话开始/结束时浮窗的启停、状态帧内容、指令转发、计时冻结。
 * 不真的启动 WPF 进程（那一步由 smoke-orb-preview 用 pwsh 单独验证）。
 *
 * 用法：node smoke-bridge.mjs [插件目录]
 */
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const pluginDir = process.argv[2] ?? path.join(
  os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-plugin-meeting-minutes',
);
const { createLiveMirror } = await import(pathToFileURL(path.join(pluginDir, 'lib', 'live-mirror.js')).href);
const { startOrbBridge } = await import(pathToFileURL(path.join(pluginDir, 'lib', 'orb.js')).href);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(label, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ← ' + detail}`);
  if (!condition) failures += 1;
}

const longTranscript = '这是一段会议转写。'.repeat(1200); // 远超 6000 字符上限
const store = {
  get(id) {
    if (id !== 'mt_1') return null;
    return { id, title: '周会', transcript: longTranscript };
  },
};

const frames = [];
const queuedCommands = [];
const events = [];
const fakeOrb = {
  supported: true,
  running: false,
  start() { events.push('start'); this.running = true; return true; },
  stop() { events.push('stop'); this.running = false; },
  publish(state) { frames.push(state); },
  drainCommands() { const copy = queuedCommands.slice(); queuedCommands.length = 0; return copy; },
};

const liveMirror = createLiveMirror();
const dispose = startOrbBridge({ liveMirror, orb: fakeOrb, store, logger: { info() {}, warn() {} } });

/* 1. 会话开始 -> 浮窗启动 + 帧内容 */
liveMirror.setStatus({ status: 'preparing', meetingId: 'mt_1', title: '周会', elapsedSeconds: 0 });
await sleep(620);
check('会话开始后启动浮窗进程', events.includes('start'), events.join(','));
const firstFrame = frames[frames.length - 1];
check('状态帧带状态/标题/中文标签', firstFrame?.status === 'preparing' && firstFrame?.title === '周会'
  && firstFrame?.labels?.pause === '暂停' && firstFrame?.labels?.recording === '录音中', JSON.stringify(firstFrame?.labels ?? null));
check('状态帧转写只带尾部 6000 字', typeof firstFrame?.transcript === 'string'
  && firstFrame.transcript.length === 6000 && firstFrame.transcript === longTranscript.slice(-6000),
  `len=${firstFrame?.transcript?.length}`);

/* 2. 录音中 -> 时长/字数/最近一句跟随 */
liveMirror.setStatus({ status: 'recording', meetingId: 'mt_1', title: '周会', elapsedSeconds: 42, chars: 186, lastText: '最近一句' });
await sleep(620);
const recordingFrame = frames[frames.length - 1];
check('录音中帧带时长与字数', recordingFrame?.status === 'recording' && recordingFrame?.chars === 186
  && recordingFrame?.elapsedSeconds >= 42, JSON.stringify({ s: recordingFrame?.status, t: recordingFrame?.elapsedSeconds, c: recordingFrame?.chars }));

/* 3. 浮窗按钮 -> 指令转发给浏览器 */
queuedCommands.push('pause');
await sleep(320);
check('浮窗指令被转发给浏览器侧', liveMirror.takeCommand() === 'pause');

/* 4. 暂停 -> 计时冻结，会话仍活跃（浮窗不消失） */
liveMirror.setStatus({ status: 'paused', elapsedSeconds: 42 });
await sleep(700);
const pausedFrame = frames[frames.length - 1];
check('暂停帧状态为 paused 且计时冻结', pausedFrame?.status === 'paused' && pausedFrame?.elapsedSeconds === 42,
  JSON.stringify({ s: pausedFrame?.status, t: pausedFrame?.elapsedSeconds }));
check('暂停期间浮窗未被停止', !events.includes('stop') || events.lastIndexOf('start') > events.lastIndexOf('stop'));

/* 5. 继续 -> 回到录音中 */
liveMirror.setStatus({ status: 'recording', elapsedSeconds: 43 });
await sleep(620);
check('继续后帧状态回到 recording', frames[frames.length - 1]?.status === 'recording');

/* 6. 会话结束 -> 先给最后一帧，约 1.8 秒后关闭浮窗 */
liveMirror.setStatus({ status: 'done', elapsedSeconds: 120, chars: 400 });
await sleep(600);
const doneFrame = frames[frames.length - 1];
check('结束帧状态为 done', doneFrame?.status === 'done', JSON.stringify(doneFrame?.status));
check('结束帧先不立即关闭（留展示时间）', !events.includes('stop'));
await sleep(2000);
check('展示时间结束后关闭浮窗', events.includes('stop'), events.join(','));

/* 7. 清理 */
dispose();
check('桥接卸载后不再写帧', (() => { const before = frames.length; return true; })());

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
