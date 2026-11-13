/**
 * 离线功能测试：直接调用被补丁后的宿主路由，验证
 *   1) 「识别结果为空」不再中断录音
 *   2) 其他错误仍如实报错
 *   3) 正常识别路径不受影响
 *   4) POST /live/status 心跳能存状态并把浮窗指令带回浏览器
 * 只读插件文件，不写任何东西。
 *
 * 用法：node smoke-server.mjs [插件目录]
 */
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const pluginDir = process.argv[2] ?? path.join(
  os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-plugin-meeting-minutes',
);
const serverFile = path.join(pluginDir, 'lib', 'server.js');
const mirrorFile = path.join(pluginDir, 'lib', 'live-mirror.js');

const { registerRoutes } = await import(pathToFileURL(serverFile).href);
const { createLiveMirror } = await import(pathToFileURL(mirrorFile).href);

function makeWav(seconds) {
  const rate = 16000;
  const frames = Math.round(rate * seconds);
  const data = Buffer.alloc(frames * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function makeReq(method, url, body) {
  return {
    method,
    url,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield body;
    },
  };
}

function makeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

function makeStore() {
  const meeting = {
    id: 'mt_test', title: '测试', transcript: '', transcriptSeconds: 0,
    todos: [
      { id: 'td_1', title: '确认 Q4 预算', owner: '张三', due: '2026-11-20', priority: 'high', status: 'pending', calendarTaskId: null },
      { id: 'td_2', title: '补充供应商清单', owner: '', due: '', priority: 'normal', status: 'pending', calendarTaskId: null },
    ],
  };
  return {
    file: 'meeting-minutes.json',
    async load() {},
    get(id) { return id === 'mt_test' ? meeting : null; },
    async patch(id, patch) {
      if (id !== 'mt_test') return null;
      Object.assign(meeting, patch);
      return meeting;
    },
    async remove(id) {
      return id === 'mt_test' ? meeting : null;
    },
    async markTodoPushed(meetingId, todoId, calendarTaskId) {
      if (meetingId !== 'mt_test') return null;
      const todo = (meeting.todos ?? []).find((item) => item.id === todoId);
      if (todo !== undefined) todo.calendarTaskId = calendarTaskId;
      return meeting;
    },
    async appendTranscript(id, text, seconds) {
      if (text !== '') meeting.transcript = text;
      meeting.transcriptSeconds += Math.max(0, Number(seconds) || 0);
      return meeting;
    },
  };
}

let failures = 0;
function check(label, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ← ' + detail}`);
  if (!condition) failures += 1;
}

async function runRoute(asrImpl, extraDeps = {}) {
  let handler = null;
  const ctx = { webServer: { register: (route) => { handler = route.handler; return () => {}; } } };
  const deps = {
    store: makeStore(),
    asr: asrImpl,
    summarizer: {},
    calendar: { status: async () => ({ available: false }) },
    autoIngest: { status: () => ({}) },
    logger: console,
    ...extraDeps,
  };
  registerRoutes(ctx, deps);
  if (handler === null) throw new Error('路由未注册');
  return async (method, url, body, contentType) => {
    const res = makeRes();
    const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    const req = makeReq(method, url, payload);
    if (contentType) req.headers['content-type'] = contentType;
    await handler(req, res);
    return res;
  };
}

/* 1. 空识别结果：补丁后应返回 200 + 空文本 + 记录时长（原来会 400 并中断录音） */
const ask = await runRoute({
  status: () => ({ available: true, providers: [], selection: {} }),
  prepare: () => {},
  async transcribeWav() { throw new Error('语音识别没有识别出任何文字'); },
});
const emptyCase = await ask('POST', '/dsh-meeting/meetings/mt_test/transcribe?language=zh', makeWav(2));
const emptyPayload = JSON.parse(emptyCase.body);
check('空识别结果返回 200（不再中断录音）', emptyCase.status === 200, `status=${emptyCase.status}`);
check('响应 ok=true 且文本为空', emptyPayload.ok === true && emptyPayload.text === '', emptyCase.body.slice(0, 120));
check('时长按 WAV 字节折算并入库（2 秒）', Math.abs(Number(emptyPayload.audioSeconds) - 2) < 0.05, `audioSeconds=${emptyPayload.audioSeconds}`);
check('会议累计时长被写入', Math.abs(Number(emptyPayload.transcriptSeconds) - 2) < 0.05, `transcriptSeconds=${emptyPayload.transcriptSeconds}`);

/* 2. 其他错误仍要如实报错（不能把真故障也吞掉） */
const askError = await runRoute({
  status: () => ({ available: true, providers: [], selection: {} }),
  prepare: () => {},
  async transcribeWav() { throw new Error('语音识别失败（第 1/1 段）：worker crashed'); },
});
const realErrorCase = await askError('POST', '/dsh-meeting/meetings/mt_test/transcribe?language=zh', makeWav(1));
const errorPayload = JSON.parse(realErrorCase.body);
check('其他识别错误仍返回 400', realErrorCase.status === 400, `status=${realErrorCase.status}`);
check('错误信息原样透出', errorPayload.ok === false && String(errorPayload.error).includes('worker crashed'), errorPayload.error);

/* 3. 正常识别结果路径不受影响 */
const askOk = await runRoute({
  status: () => ({ available: true, providers: [], selection: {} }),
  prepare: () => {},
  async transcribeWav() { return { text: '大家好，我们开始开会。', audioSeconds: 5, inferenceSeconds: 0.4 }; },
});
const okCase = await askOk('POST', '/dsh-meeting/meetings/mt_test/transcribe?language=zh', makeWav(5));
const okPayload = JSON.parse(okCase.body);
check('正常识别仍返回 200 且带文本', okCase.status === 200 && okPayload.text === '大家好，我们开始开会。' && okPayload.transcript === '大家好，我们开始开会。');

/* 4. 浮窗心跳：状态入库 + 指令带回 */
const liveMirror = createLiveMirror();
const askLive = await runRoute({
  status: () => ({ available: true, providers: [], selection: {} }),
  prepare: () => {},
  async transcribeWav() { return { text: '', audioSeconds: 0 }; },
}, { liveMirror });

const heartbeat = JSON.stringify({
  status: 'recording', meetingId: 'mt_test', title: 'Q4 预算会',
  elapsedSeconds: 42, chars: 186, lastText: '最近一句',
});
const beat1 = JSON.parse((await askLive('POST', '/dsh-meeting/live/status', heartbeat, 'application/json')).body);
check('心跳返回 ok 且无指令时 command=null', beat1.ok === true && beat1.command === null, JSON.stringify(beat1));
const mirrored = liveMirror.snapshot();
check('心跳状态进入宿主镜像', mirrored.status === 'recording' && mirrored.meetingId === 'mt_test'
  && mirrored.title === 'Q4 预算会' && mirrored.chars === 186, JSON.stringify(mirrored));
check('镜像会自走计时（心跳间不冻结）', mirrored.elapsedSeconds >= 42);

liveMirror.queueCommand('pause');
const beat2 = JSON.parse((await askLive('POST', '/dsh-meeting/live/status', heartbeat, 'application/json')).body);
check('浮窗指令随下一次心跳返回', beat2.command === 'pause', JSON.stringify(beat2));
const beat3 = JSON.parse((await askLive('POST', '/dsh-meeting/live/status', heartbeat, 'application/json')).body);
check('指令只消费一次（不重复执行）', beat3.command === null, JSON.stringify(beat3));

liveMirror.setStatus({ status: 'paused', elapsedSeconds: 42 });
const pausedSnapshot = liveMirror.snapshot();
check('暂停后镜像状态为 paused 且计时冻结', pausedSnapshot.status === 'paused' && pausedSnapshot.elapsedSeconds === 42, JSON.stringify(pausedSnapshot));
check('暂停仍算活跃会话（浮窗不消失）', liveMirror.isActive() === true);

liveMirror.setStatus({ status: 'done', elapsedSeconds: 42 });
check('结束会话后不再活跃', liveMirror.isActive() === false);


/* 9. 写入 DSH 待办（工作轨）：/meetings/:id/todos/push 走 dshTodo 而不是任务日历 */
const pushed = [];
const fakeDshTodo = {
  async ready() { return true },
  status() { return { available: true, target: 'dsh-todo', dir: '/tmp/memories' } },
  async describe() { return { available: true, target: 'dsh-todo', dir: '/tmp/memories' } },
  add(content, meta) {
    pushed.push({ content, meta });
    return { ok: true, id: 'abc1234', message: 'ok' };
  },
};
const askTodos = await runRoute({
  status: () => ({ available: true, providers: [], selection: {} }),
  prepare: () => {},
  async transcribeWav() { return { text: '', audioSeconds: 0 }; },
}, { dshTodo: fakeDshTodo });
const todoCase = await askTodos('POST', '/dsh-meeting/meetings/mt_test/todos/push', '{}', 'application/json');
const todoPayload = JSON.parse(todoCase.body);
check('写入待办返回 200', todoCase.status === 200, `status=${todoCase.status} ${todoCase.body.slice(0, 120)}`);
check('两条待办都写进 DSH 待办', Array.isArray(todoPayload.created) && todoPayload.created.length === 2, JSON.stringify(todoPayload.created));
check('写入标记为 dsh-todo:<id>', todoPayload.created?.every((entry) => String(entry.calendarTaskId).startsWith('dsh-todo:')) === true, JSON.stringify(todoPayload.created));
check('待办文本带上负责人', pushed.length === 2 && pushed[0].content.includes('确认 Q4 预算') && pushed[0].content.includes('张三'), JSON.stringify(pushed));
check('待办落到工作类型（cat=会议纪要、优先级映射象限）', pushed[0]?.meta?.cat === '会议纪要' && pushed[0]?.meta?.quadrant === 'q1' && pushed[0]?.meta?.due === '2026-11-20', JSON.stringify(pushed[0]?.meta));
check('状态接口回报待办可用', todoPayload.calendar?.available === true && todoPayload.calendar?.target === 'dsh-todo', JSON.stringify(todoPayload.calendar));


/* 16. 录屏 / 音频文件落盘：二进制上传 → 存到 <DSH_HOME>/storages/meeting-minutes-media/<id>/ */
const mediaOs = (await import('node:os')).default
const mediaFs = (await import('node:fs/promises')).default
const mediaPath = (await import('node:path')).default
const mediaHome = await mediaFs.mkdtemp(mediaPath.join(mediaOs.tmpdir(), 'mm-media-'))
process.env.DSH_HOME = mediaHome
const wavBytes = Buffer.from('RIFFxxxxWAVEfmt fake audio payload', 'utf8')
const uploadCase = await runRoute({
  status: () => ({ available: true, providers: [], selection: {} }),
  prepare: () => {},
  async transcribeWav() { return { text: '', audioSeconds: 0 }; },
});
const uploadRes = await uploadCase('POST', '/dsh-meeting/meetings/mt_test/media/upload?kind=audio&name=a.wav&seconds=42', wavBytes, 'application/octet-stream')
const uploadPayload = JSON.parse(uploadRes.body)
check('音频文件上传返回 200', uploadRes.status === 200, uploadRes.body.slice(0, 120))
check('会议 media 记录音频文件', Array.isArray(uploadPayload.media) && uploadPayload.media.length === 1 && uploadPayload.media[0].kind === 'audio', JSON.stringify(uploadPayload.media))
const uploadedPath = String(uploadPayload.media?.[0]?.path ?? '')
const uploadedExists = await mediaFs.stat(uploadedPath).then(() => true).catch(() => false)
check('文件真的写到磁盘', uploadPayload.media?.[0]?.bytes === wavBytes.length && uploadedExists, uploadedPath)
check('文件落在 storages/meeting-minutes-media 下', uploadedPath.includes('meeting-minutes-media') && uploadedPath.startsWith(mediaHome), uploadedPath)

const videoBytes = Buffer.from('fake webm with audio', 'utf8')
const videoRes = await uploadCase('POST', '/dsh-meeting/meetings/mt_test/media/upload?kind=video&name=b.webm&seconds=42', videoBytes, 'application/octet-stream')
const videoPayload = JSON.parse(videoRes.body)
check('视频文件上传后两种媒体都在', Array.isArray(videoPayload.media) && videoPayload.media.length === 2, JSON.stringify(videoPayload.media?.map((item) => item.kind)))
check('视频条目标记为正在转 MP4', videoPayload.entry?.converting === true && videoPayload.media.filter((item) => item.kind === 'video').every((item) => item.converting === true), JSON.stringify(videoPayload.media?.map((item) => ({ kind: item.kind, converting: item.converting }))))

const traversalRes = await uploadCase('POST', '/dsh-meeting/meetings/mt_test/media/upload?kind=audio&name=..%2F..%2Fevil.wav', Buffer.from('x'), 'application/octet-stream')
const traversalPayload = JSON.parse(traversalRes.body)
const traversalPath = String(traversalPayload.entry?.path ?? '')
check('文件名做了路径穿越清洗', traversalRes.status === 200 && traversalPath.startsWith(mediaHome), traversalPath)


/* 17. 用系统默认播放器打开媒体文件（测试环境用 DSH_MEETING_NO_OPEN=1 不真的拉起播放器） */
process.env.DSH_MEETING_NO_OPEN = '1'
const openCase = await uploadCase('POST', '/dsh-meeting/meetings/mt_test/media/open', JSON.stringify({ kind: 'audio' }), 'application/json')
const openPayload = JSON.parse(openCase.body)
check('播放接口返回 200 且已处理', openCase.status === 200 && openPayload.opened === true && String(openPayload.path).endsWith('.wav'), openCase.body.slice(0, 140))
const openMissing = await uploadCase('POST', '/dsh-meeting/meetings/mt_test/media/open', JSON.stringify({ kind: 'text' }), 'application/json')
check('没有该类型文件时如实报错', openMissing.status === 400, openMissing.body.slice(0, 140))
delete process.env.DSH_MEETING_NO_OPEN

await mediaFs.rm(mediaHome, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
