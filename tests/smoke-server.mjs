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
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installedDir = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-meeting-live');
// 默认优先用本机已安装版本（与 DSH 实际运行一致）；别人 clone 仓库跑测试时自动退回 src/
const pluginDir = process.argv[2] ?? (fs.existsSync(installedDir) ? installedDir : path.join(repoRoot, 'src'));
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
    summary: {
      oneLine: '', overview: '', keyPoints: [], decisions: [], risks: [], sections: [], attendees: [],
      todos: [
        { id: 'td_1', title: '确认 Q4 预算', owner: '张三', due: '2026-11-20', priority: 'high', status: 'pending', calendarTaskId: null },
        { id: 'td_2', title: '补充供应商清单', owner: '', due: '', priority: 'normal', status: 'pending', calendarTaskId: null },
      ],
    },
  };
  return {
    file: 'meeting-minutes.json',
    snapshot() { return { meetings: [] }; },
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
      const todo = (meeting.summary?.todos ?? []).find((item) => item.id === todoId);
      if (todo !== undefined) todo.calendarTaskId = calendarTaskId;
      return meeting;
    },
    summaryModel: null,
    settings: {
      transcribe: { provider: 'sensevoice-local', cloud: { iflytek: {}, tencent: {}, aliyun: {} } },
      summary: { mode: 'dsh', custom: { baseUrl: '', apiKey: '', model: '', temperature: 0.3, maxTokens: 8192 } },
      terms: '',
      correctTranscript: false,
      diarize: false,
    },
    async setSettings(next) {
      this.settings = next
      return next
    },
    async setSummaryModel(next) {
      this.summaryModel = next === null || next === undefined ? null : { provider: String(next.provider), model: String(next.model) };
      return this.summaryModel;
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
    summarizer: { describeRoute: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
    calendar: { status: async () => ({ available: false }) },
    autoIngest: { status: () => ({}) },
    logger: console,
    modelManager: {
      status: () => ({ dir: 'x', assets: {}, downloading: null }),
      download: async () => ({ ok: true }),
      remove: async () => ({ ok: true }),
      paths: () => ({}),
    },
    paraformer: { available: () => true, diarizationAvailable: () => false },
    cloudAsr: { transcribeCloud: async () => ({ ok: true, text: '云端识别结果' }) },
    ctx: {
      get: (service) => {
        if (service === 'llm') {
          return {
            listProviders: () => [
              { id: 'deepseek-official', displayName: 'DeepSeek 官方' },
              { id: 'pi-ai', displayName: 'Pi AI' },
            ],
            listModels: async (provider) => {
              if (provider === 'pi-ai') throw new Error('该适配器不提供模型目录');
              return [
                { provider, id: 'deepseek-flash', name: 'DeepSeek Flash' },
                { provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
              ];
            },
          };
        }
        if (service === 'agentDefaultModel') {
          return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) };
        }
        return undefined;
      },
    },
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

/* 3.1 本地 Paraformer 引擎：路由传给它的音频必须是 Buffer
   （回归：readRawBody 曾返回 Uint8Array，每个分片都报「音频数据无效」，整场录音中断） */
{
  const store = makeStore();
  store.settings.transcribe.provider = 'paraformer-local';
  let received = null;
  const askPara = await runRoute(
    { status: () => ({ available: true, providers: [], selection: {} }), prepare: () => {} },
    {
      store,
      paraformer: {
        available: () => true,
        diarizationAvailable: () => false,
        async transcribeWav(bytes) {
          received = bytes;
          return { text: '本地引擎结果', audioSeconds: 1, inferenceSeconds: 0.1 };
        },
      },
    },
  );
  const paraCase = await askPara('POST', '/dsh-meeting/meetings/mt_test/transcribe?language=zh', makeWav(1));
  const paraPayload = JSON.parse(paraCase.body);
  check('Paraformer 路由收到的是 Buffer', Buffer.isBuffer(received), received?.constructor?.name);
  check('Paraformer 转写正常返回文本', paraCase.status === 200 && paraPayload.text === '本地引擎结果', paraCase.body.slice(0, 120));
}

/* 3.2 单个分片解码失败（音频数据无效）按空结果处理，不再中断整场录音 */
{
  const askBadChunk = await runRoute({
    status: () => ({ available: true, providers: [], selection: {} }),
    prepare: () => {},
    async transcribeWav() { throw new Error('音频数据无效'); },
  });
  const badChunkCase = await askBadChunk('POST', '/dsh-meeting/meetings/mt_test/transcribe?language=zh', makeWav(1));
  const badChunkPayload = JSON.parse(badChunkCase.body);
  check('音频数据无效降级为 200 空结果', badChunkCase.status === 200 && badChunkPayload.ok === true && badChunkPayload.text === '', badChunkCase.body.slice(0, 120));
}

/* 3.3 decodeWavToSamples 兼容 Uint8Array（双保险） */
{
  const { decodeWavToSamples } = await import(pathToFileURL(path.join(pluginDir, 'lib', 'paraformer.js')).href);
  const decoded = decodeWavToSamples(new Uint8Array(makeWav(1)));
  check('decodeWavToSamples 接受 Uint8Array', decoded.samples.length === 16000, String(decoded.samples.length));
}

/* 3.4 整段说话人分离结果不得把长转写覆盖成几个碎片 */
{
  const { shouldUseDiarizedTranscript } = await import(pathToFileURL(path.join(pluginDir, 'lib', 'server.js')).href);
  check('批量结果明显更短时保留流式转写', shouldUseDiarizedTranscript('长'.repeat(500), '短'.repeat(20)) === false);
  check('批量结果更长时采用批量结果', shouldUseDiarizedTranscript('短'.repeat(20), '长'.repeat(500)) === true);
  check('原转写为空时采用批量结果', shouldUseDiarizedTranscript('', '任意文本') === true);
  check('批量结果为空时保留原转写', shouldUseDiarizedTranscript('已有内容', '') === false);
}

/* 3.5 整段重转写：30 秒切片 + 分片文本合并 */
{
  const { planRetranscribeSlices, mergeRetranscribeTexts } = await import(pathToFileURL(path.join(pluginDir, 'lib', 'server.js')).href);
  const slices = planRetranscribeSlices(65 * 16000, 16000, 30);
  check('65 秒音频切成 3 片', slices.length === 3 && slices[0].startFrame === 0 && slices[2].endFrame === 65 * 16000
    && slices[2].at === 60, JSON.stringify(slices));
  check('分片带起始秒数', slices[1].at === 30, String(slices[1].at));
  check('合并分片文本丢弃空片', mergeRetranscribeTexts(['第一段', '', '  第二段  ']) === '第一段\n第二段');
  check('全空分片合并为空串', mergeRetranscribeTexts(['', '  ', null]) === '');
}

/* 3.6 整段重转写路由：启动任务 → 轮询进度 → 写回转写 */
{
  const fsMod = (await import('node:fs')).default;
  const tmpWav = path.join(os.tmpdir(), 'dsh-mm-retrans-test.wav');
  fsMod.writeFileSync(tmpWav, makeWav(2));
  const store = makeStore();
  await store.patch('mt_test', { media: [{ kind: 'audio', name: 'test.wav', path: tmpWav, bytes: 44, seconds: 2 }] });
  const fakeParaformer = {
    available: () => true,
    diarizationAvailable: () => false,
    decodeWavToSamples: () => ({ samples: new Float32Array(16000 * 2), sampleRate: 16000, channels: 1 }),
    transcribeWav: async () => ({ text: '整段重转写测试文本', audioSeconds: 1, inferenceSeconds: 0 }),
  };
  const askRetrans = await runRoute(
    { status: () => ({ available: true, providers: [], selection: {} }), prepare: () => {} },
    { store, paraformer: fakeParaformer },
  );
  const started = JSON.parse((await askRetrans('POST', '/dsh-meeting/meetings/mt_test/retranscribe')).body);
  check('整段重转写任务可启动', started.ok === true && started.job?.status === 'running', JSON.stringify(started.job ?? null));
  let job = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const polled = JSON.parse((await askRetrans('GET', '/dsh-meeting/meetings/mt_test/retranscribe')).body);
    job = polled.job ?? null;
    if (job !== null && job.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  check('整段重转写任务能跑完', job?.status === 'done', JSON.stringify(job ?? null));
  const patched = store.get('mt_test');
  check('整段重转写结果写回会议转写', typeof patched?.transcript === 'string' && patched.transcript.includes('整段重转写测试文本'),
    String(patched?.transcript ?? '').slice(0, 60));
  check('整段重转写覆盖分段与时长', Array.isArray(patched?.transcriptSegments) && patched.transcriptSegments.length > 0
    && patched.transcriptSeconds === 2, JSON.stringify({ segments: patched?.transcriptSegments?.length, seconds: patched?.transcriptSeconds }));
  fsMod.rmSync(tmpWav, { force: true });
}

/* 3.7 历史数据自愈：转写被覆盖成碎片时用分段恢复 */
{
  const { repairTruncatedTranscripts } = await import(pathToFileURL(path.join(pluginDir, 'lib', 'store.js')).href);
  const segA = '这是第一段比较长的会议内容，用来验证转写被覆盖后的恢复逻辑是否真的生效。'.repeat(4);
  const segB = '这是第二段比较长的会议内容，同样应该被拼回整段转写里面去才对。'.repeat(4);
  const segC = '这是第三段比较长的会议内容，三段加起来超过两百个字肯定没问题。'.repeat(4);
  const broken = {
    transcript: 'S1：我就先了',
    transcriptSegments: [
      { speaker: 'A', text: segA },
      { speaker: 'B', text: segB },
      { speaker: 'A', text: segC },
    ],
  };
  const touched = repairTruncatedTranscripts([broken]);
  check('被覆盖的短转写能从分段恢复', touched === 1 && broken.transcript.includes('第一段比较长的会议内容')
    && broken.transcript.includes('A：') && broken.transcript.split('\n').length === 3, JSON.stringify(broken.transcript.slice(0, 60)));
  const healthy = { transcript: '正常转写内容'.repeat(60), transcriptSegments: broken.transcriptSegments };
  check('正常转写不会被自愈逻辑改动', repairTruncatedTranscripts([healthy]) === 0 && healthy.transcript === '正常转写内容'.repeat(60));
  const fewSegments = { transcript: '短', transcriptSegments: [{ speaker: 'A', text: '只有一段' }] };
  check('分段太少不改动（避免误伤）', repairTruncatedTranscripts([fewSegments]) === 0 && fewSegments.transcript === '短');
}

/* 3.8 重新生成待办：只追加新行动项，旧待办保留 */
{
  const store = makeStore();
  const askTodos = await runRoute(
    { status: () => ({ available: true, providers: [], selection: {} }), prepare: () => {} },
    {
      store,
      summarizer: {
        async extractTodos() {
          return [
            { title: '新行动项：补一份排期表', owner: '', due: '', priority: 'normal', notes: '' },
            { title: '新行动项：确认供应商名单', owner: '李娜', due: '2026-11-20', priority: 'high', notes: '' },
          ];
        },
      },
    },
  );
  const regenerated = JSON.parse((await askTodos('POST', '/dsh-meeting/meetings/mt_test/todos/regenerate')).body);
  check('重新生成待办能追加新条目', regenerated.ok === true && regenerated.added === 2
    && regenerated.todos.some((todo) => String(todo.title).includes('补一份排期表')), JSON.stringify({ added: regenerated.added }));
  check('重新生成待办保留旧条目', regenerated.todos.length >= 4, String(regenerated.todos.length));
}

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
check('写入内容带上负责人与截止信息（保持单行）', pushed.length === 2
  && pushed[0].content.includes('张三') && pushed[0].content.includes('截止：2026-11-20')
  && !pushed[0].content.includes('\n')
  && pushed[0].meta.due === '2026-11-20', JSON.stringify(pushed[0]));
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
check('视频上传后作为普通视频条目保存', videoPayload.entry?.kind === 'video' && videoPayload.entry?.converting !== true, JSON.stringify(videoPayload.media?.map((item) => ({ kind: item.kind, converting: item.converting }))))

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


/* 18. 宿主录屏接口（测试模式只验接口，不真的采集屏幕） */
process.env.DSH_MEETING_NO_SCREEN = '1'
const stateRes = await uploadCase('GET', '/dsh-meeting/state');
const statePayload = JSON.parse(stateRes.body)
check('状态接口返回 ffmpeg 可用标记（首次引导据此提示安装）', stateRes.status === 200 && typeof statePayload.screen?.ffmpegReady === 'boolean', JSON.stringify({ status: stateRes.status, screen: statePayload.screen }))
check('状态接口返回当前插件版本', stateRes.status === 200 && typeof statePayload.version === 'string' && /^\d+\.\d+\.\d+/.test(statePayload.version), JSON.stringify(statePayload.version))

/* 更新检查接口：用桩 fetch 验证「只查版本、返回下载页」 */
{
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('registry.npmjs.org')) {
      return { ok: true, json: async () => ({ version: '999.0.0' }) }
    }
    return { ok: false, json: async () => ({}) }
  }
  const updateRes = await uploadCase('GET', '/dsh-meeting/update-check?force=1')
  const updatePayload = JSON.parse(updateRes.body)
  globalThis.fetch = originalFetch
  check('更新检查接口返回结构与当前版本', updateRes.status === 200 && typeof updatePayload.current === 'string' && updatePayload.current === statePayload.version, JSON.stringify(updatePayload))
  const downloadUrlOk = /releases\/latest$/.test(updatePayload.url ?? '') || /^https:\/\/www\.npmjs\.com\/package\//.test(updatePayload.url ?? '')
  check('更新检查接口能识别新版本并给出下载页', updatePayload.ok === true && updatePayload.hasUpdate === true && downloadUrlOk, JSON.stringify(updatePayload.url))
  check('更新检查不会自动安装（只有提示字段）', updatePayload.install === undefined && updatePayload.download === undefined, JSON.stringify(Object.keys(updatePayload)))
}
const settingsVersionRes = await uploadCase('GET', '/dsh-meeting/settings')
const settingsVersionPayload = JSON.parse(settingsVersionRes.body)
check('设置接口返回当前插件版本（问题反馈页显示用）', settingsVersionRes.status === 200 && settingsVersionPayload.version === statePayload.version, JSON.stringify(settingsVersionPayload.version))
const sourcesRes = await uploadCase('GET', '/dsh-meeting/screen/sources')
const sourcesPayload = JSON.parse(sourcesRes.body)
check('屏幕源接口返回桌面源', sourcesRes.status === 200 && Array.isArray(sourcesPayload.sources) && sourcesPayload.sources.length >= 1, sourcesRes.body.slice(0, 140))
const startScreen = await uploadCase('POST', '/dsh-meeting/meetings/mt_test/screen/start', JSON.stringify({ source: 'desktop' }), 'application/json')
check('开始录屏返回 200', startScreen.status === 200 && JSON.parse(startScreen.body).ok === true, startScreen.body.slice(0, 140))
const stopScreen = await uploadCase('POST', '/dsh-meeting/meetings/mt_test/screen/stop', '{}', 'application/json')
check('停止录屏返回 200', stopScreen.status === 200 && JSON.parse(stopScreen.body).ok === true, stopScreen.body.slice(0, 140))
const identifyRes = await uploadCase('POST', '/dsh-meeting/screen/identify', JSON.stringify({ source: 'desktop' }), 'application/json')
check('屏幕识别接口返回 200', identifyRes.status === 200 && JSON.parse(identifyRes.body).ok === true, identifyRes.body.slice(0, 140))
const stopAgain = await uploadCase('POST', '/dsh-meeting/meetings/mt_test/screen/stop', '{}', 'application/json')
check('没有录屏时停止会如实报错', stopAgain.status === 400, stopAgain.body.slice(0, 140))
delete process.env.DSH_MEETING_NO_SCREEN


/* 19. 设置接口：模型目录 / 默认模型 / 保存选择 */
const settingsRes = await uploadCase('GET', '/dsh-meeting/settings')
const settingsPayload = JSON.parse(settingsRes.body)
const modelIds = (settingsPayload.models || []).map((item) => item.id)
check('设置接口返回模型目录', settingsRes.status === 200 && modelIds.length === 2 && modelIds.includes('deepseek-flash'), JSON.stringify(modelIds))
check('设置接口返回 DSH 默认模型', settingsPayload.defaultModel?.provider === 'deepseek-official' && settingsPayload.defaultModel?.model === 'deepseek-flash', JSON.stringify(settingsPayload.defaultModel))
check('未配置时 model 为 null（跟随默认）', settingsPayload.model === null, JSON.stringify(settingsPayload.model))
const saveModel = await uploadCase('PATCH', '/dsh-meeting/settings', JSON.stringify({ model: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } }), 'application/json')
check('保存模型选择返回 200', saveModel.status === 200 && JSON.parse(saveModel.body).model?.model === 'deepseek-v4-pro', saveModel.body.slice(0, 140))
const settingsAgain = JSON.parse((await uploadCase('GET', '/dsh-meeting/settings')).body)
check('重新读取仍是已保存的模型', settingsAgain.model?.provider === 'deepseek-official' && settingsAgain.model?.model === 'deepseek-v4-pro', JSON.stringify(settingsAgain.model))
const clearModel = await uploadCase('PATCH', '/dsh-meeting/settings', JSON.stringify({ model: null }), 'application/json')
check('可以恢复为跟随默认模型', clearModel.status === 200 && JSON.parse(clearModel.body).model === null, clearModel.body.slice(0, 140))


/* 20. 导出：Word (.docx) 生成 */
const previousHome = process.env.DSH_HOME
const docxHome = await mediaFs.mkdtemp(mediaPath.join(mediaOs.tmpdir(), 'mm-docx-home-'))
process.env.DSH_HOME = docxHome
const docxRes = await uploadCase('GET', '/dsh-meeting/meetings/mt_test/export?format=docx')
const docxPayload = JSON.parse(docxRes.body)
const docxBase64 = String(docxPayload.base64 ?? '')
const docxXml = Buffer.from(docxBase64, 'base64').toString('utf8');
check('Word 导出包含美化标记（表头重复/底纹/分页/标题色）', docxXml.includes('<w:tblHeader/>')
  && docxXml.includes('<w:shd')
  && docxXml.includes('D9E2F3') && docxXml.includes('1F3A6E'), '')
check('Word 导出返回 base64 与 .docx 文件名', docxRes.status === 200 && docxPayload.format === 'docx' && String(docxPayload.filename).endsWith('.docx') && docxBase64.length > 100, JSON.stringify({ format: docxPayload.format, filename: docxPayload.filename, base64Length: docxBase64.length }))
check('Word 包以 ZIP 魔数开头（PK）', Buffer.from(docxBase64, 'base64').subarray(0, 2).toString('ascii') === 'PK', '')
if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
await mediaFs.rm(docxHome, { recursive: true, force: true })


/* 21. 设置：转写引擎 / 云端校验 / 模型状态 */
const settingsV2 = JSON.parse((await uploadCase('GET', '/dsh-meeting/settings')).body)
check('设置返回转写与总结配置', settingsV2.settings?.transcribe?.provider === 'sensevoice-local' && Array.isArray(settingsV2.transcribeProviders), JSON.stringify(settingsV2.settings?.transcribe))
check('设置返回模型状态与引擎就绪标记', settingsV2.modelsState !== null && settingsV2.paraformerReady === true, JSON.stringify({ modelsState: settingsV2.modelsState, paraformerReady: settingsV2.paraformerReady }))
const switchLocal = await uploadCase('PATCH', '/dsh-meeting/settings', JSON.stringify({ settings: { transcribe: { provider: 'paraformer-local' } } }), 'application/json')
check('可以切到本地 Paraformer 引擎', switchLocal.status === 200 && JSON.parse(switchLocal.body).settings?.transcribe?.provider === 'paraformer-local', switchLocal.body.slice(0, 160))
const badCloud = await uploadCase('PATCH', '/dsh-meeting/settings', JSON.stringify({ settings: { transcribe: { provider: 'cloud-iflytek' } } }), 'application/json')
check('切云端缺凭据可保存并返回警告', badCloud.status === 200 && Array.isArray(JSON.parse(badCloud.body).warnings) && String(JSON.parse(badCloud.body).warnings.join(' ')).includes('讯飞'), badCloud.body.slice(0, 200))
const badSummary = await uploadCase('PATCH', '/dsh-meeting/settings', JSON.stringify({ settings: { summary: { mode: 'custom' } } }), 'application/json')
check('手动总结模型缺地址可保存（使用时再校验）', badSummary.status === 200, badSummary.body.slice(0, 160))
const cloudTest = await uploadCase('POST', '/dsh-meeting/settings/cloud-test', JSON.stringify({ provider: 'cloud-tencent', cloud: { tencent: { secretId: 'a', secretKey: 'b', region: 'ap-shanghai' } } }), 'application/json')
check('云端配置校验接口可用', cloudTest.status === 200 && JSON.parse(cloudTest.body).ok === true, cloudTest.body.slice(0, 160))
const modelsStatus = await uploadCase('GET', '/dsh-meeting/models/status')
check('模型状态接口可用', modelsStatus.status === 200 && JSON.parse(modelsStatus.body).ok === true, modelsStatus.body.slice(0, 160))
const badKind = await uploadCase('POST', '/dsh-meeting/models/unknown/download')
check('未知模型类型返回 200 但状态为未开始（广播模式）', badKind.status === 200, badKind.body.slice(0, 120))

/* 22. 问题反馈：内置图片（操作指引 + 写死的公众号二维码横幅）通过 /assets 读取 */
const assetsRes = await uploadCase('GET', '/dsh-meeting/assets/guide-follow.png')
check('内置关注指引图可访问', assetsRes.status === 200 && assetsRes.headers?.['content-type'] === 'image/png' && Buffer.isBuffer(assetsRes.body) && assetsRes.body.length > 1000, `status=${assetsRes.status}`)
const chatAsset = await uploadCase('GET', '/dsh-meeting/assets/guide-chat.png')
check('内置对话指引图可访问', chatAsset.status === 200 && chatAsset.headers?.['content-type'] === 'image/png' && Buffer.isBuffer(chatAsset.body) && chatAsset.body.length > 1000, `status=${chatAsset.status}`)
const qrAsset = await uploadCase('GET', '/dsh-meeting/assets/feedback-qr.png')
check('写死的公众号二维码横幅可访问', qrAsset.status === 200 && qrAsset.headers?.['content-type'] === 'image/png' && Buffer.isBuffer(qrAsset.body) && qrAsset.body.length > 10000, `status=${qrAsset.status} bytes=${Buffer.isBuffer(qrAsset.body) ? qrAsset.body.length : 'n/a'}`)
const placeholderRes = await uploadCase('GET', '/dsh-meeting/assets/feedback-qr-placeholder.png')
check('二维码占位图可访问（文件缺失时的兜底）', placeholderRes.status === 200 && placeholderRes.headers?.['content-type'] === 'image/png', `status=${placeholderRes.status}`)
const assetMiss = await uploadCase('GET', '/dsh-meeting/assets/not-exist.png')
check('不存在的图片返回 404', assetMiss.status === 404, assetMiss.body.toString().slice(0, 120))
const assetBad = await uploadCase('GET', '/dsh-meeting/assets/..%2F..%2Fpackage.json')
check('图片名做了白名单校验（拒绝路径穿越）', assetBad.status === 400, String(assetBad.status))
const noUpload = await uploadCase('POST', '/dsh-meeting/feedback/qr', JSON.stringify({ dataUrl: 'data:image/png;base64,AAAA' }), 'application/json')
check('二维码上传接口已移除（二维码写死在插件里）', noUpload.status === 404 && String(noUpload.body).includes('未知接口'), `${noUpload.status} ${noUpload.body.slice(0, 120)}`)

/* 23. 文件夹术语解析：读取文件夹文本 → 模型排序 → 返回预览（由前端勾选保存，用桩模型，不联网） */
{
  const termOs = (await import('node:os')).default
  const termFs = (await import('node:fs')).default
  const termPath = (await import('node:path')).default
  const termRoot = termFs.mkdtempSync(termPath.join(termOs.tmpdir(), 'mm-terms-'))
  const termDir = termPath.join(termRoot, '机场平台2期')
  termFs.mkdirSync(termDir)
  termFs.writeFileSync(termPath.join(termDir, 'notes.txt'), '智慧工地平台\n张三负责 BIM 协调\n智慧工地平台二期', 'utf8')
  const secondDir = termFs.mkdtempSync(termPath.join(termOs.tmpdir(), 'mm-terms2-'))
  termFs.writeFileSync(termPath.join(secondDir, 'more.txt'), '旁站记录与数据中台', 'utf8')
  const captured = { source: '' }
  const askTerms = await runRoute({
    status: () => ({ available: true, providers: [], selection: {} }),
    prepare: () => {},
    async transcribeWav() { return { text: '', audioSeconds: 0 }; },
  }, {
    summarizer: {
      describeRoute: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
      async extractTerms(source) {
        captured.source = source
        return {
          items: [
            { text: 'BIM', category: '术语', priority: 3, count: 1, evidence: '建筑信息模型' },
            { text: '智慧工地平台', category: '产品/系统', priority: 1, count: 2, evidence: '平台名称' },
            { text: '张三', category: '人名', priority: 2, count: 1 },
            { text: '智慧工地平台', category: '术语', priority: 4, count: 2 },
          ],
        }
      },
    },
  })
  const termRes = await askTerms('POST', '/dsh-meeting/terms/extract', JSON.stringify({ dirs: [termDir, secondDir] }), 'application/json')
  const termPayload = JSON.parse(termRes.body)
  const termItems = termPayload.preview?.items ?? []
  check('文件夹术语解析返回 200 与预览（不直接覆盖）', termRes.status === 200 && termPayload.ok === true && termItems.length === 3 && termPayload.termExtract === undefined, termRes.body.slice(0, 160))
  check('术语按优先级排序并去重', termItems[0]?.text === '智慧工地平台' && termItems[0]?.priority === 1 && termItems[1]?.text === '张三' && termItems[2]?.text === 'BIM', JSON.stringify(termItems.map((item) => item.text + ':' + item.priority)))
  check('解析时读到两个文件夹的文本', captured.source.includes('智慧工地平台') && captured.source.includes('旁站记录'), captured.source.slice(0, 80))
  check('预览返回目录与合并统计（含中文目录）', termPayload.preview?.dirs?.length === 2 && termPayload.preview?.stats?.folders === 2 && termPayload.preview?.stats?.supported === 2 && String(termPayload.preview?.dirs?.[0] ?? '').includes('机场平台2期'), JSON.stringify(termPayload.preview?.dirs))
  const emptyDir = termFs.mkdtempSync(termPath.join(termOs.tmpdir(), 'mm-terms-empty-'))
  const emptyRes = await askTerms('POST', '/dsh-meeting/terms/extract', JSON.stringify({ dirs: [emptyDir] }), 'application/json')
  check('空文件夹给出中文提示', emptyRes.status === 400 && String(emptyRes.body).includes('没有可解析'), `${emptyRes.status} ${emptyRes.body.slice(0, 120)}`)
  termFs.rmSync(termRoot, { recursive: true, force: true })
  termFs.rmSync(secondDir, { recursive: true, force: true })
  termFs.rmSync(emptyDir, { recursive: true, force: true })
}

/* 24. 转写准确率提升相关接口：说话人重命名 / 纠错审阅 / 录音质量 / ASR 热词 */
{
  // 说话人重命名
  const renameRes = await uploadCase('PATCH', '/dsh-meeting/meetings/mt_test', JSON.stringify({ speakerNames: { A: '张三', B: '李四' } }), 'application/json')
  check('会议接口支持保存说话人姓名', renameRes.status === 200 && JSON.parse(renameRes.body).meeting?.speakerNames?.A === '张三', renameRes.body.slice(0, 160))

  // 纠错待审阅：写入 → 应用选中 → 转写被替换
  const correctionBody = {
    correction: {
      at: new Date().toISOString(),
      original: 'A：你好 世界\nB：收到',
      corrected: 'A：你好，世界\nB：收到',
      changes: [{ before: 'A：你好 世界', after: 'A：你好，世界' }],
    },
  }
  const setCorrection = await uploadCase('PATCH', '/dsh-meeting/meetings/mt_test', JSON.stringify(correctionBody), 'application/json')
  check('可以写入待审阅的纠错', setCorrection.status === 200 && JSON.parse(setCorrection.body).meeting?.correction?.changes?.length === 1, setCorrection.body.slice(0, 160))
  const applyCorrection = await uploadCase('POST', '/dsh-meeting/meetings/mt_test/correction/apply', JSON.stringify({ accepted: [0] }), 'application/json')
  const appliedPayload = JSON.parse(applyCorrection.body)
  check('应用选中纠错后替换转写并清空待审阅', applyCorrection.status === 200 && appliedPayload.meeting?.transcript === 'A：你好，世界\nB：收到' && appliedPayload.meeting?.correction === null, JSON.stringify({ transcript: appliedPayload.meeting?.transcript, correction: appliedPayload.meeting?.correction }))

  // 忽略纠错
  await uploadCase('PATCH', '/dsh-meeting/meetings/mt_test', JSON.stringify(correctionBody), 'application/json')
  const discardCorrection = await uploadCase('POST', '/dsh-meeting/meetings/mt_test/correction/discard', JSON.stringify({}), 'application/json')
  check('忽略纠错后只清空待审阅、不动转写', discardCorrection.status === 200 && JSON.parse(discardCorrection.body).meeting?.correction === null, discardCorrection.body.slice(0, 140))

  // 录音质量：上传一段真实 WAV 后返回质量分析
  const qualityWav = makeWav(2)
  const qualityUpload = await uploadCase('POST', '/dsh-meeting/meetings/mt_test/media/upload?kind=audio&name=quality.wav&seconds=2', qualityWav, 'audio/wav')
  const qualityPayload = JSON.parse(qualityUpload.body)
  check('音频上传后返回录音质量分析', qualityUpload.status === 200 && qualityPayload.quality !== null && typeof qualityPayload.quality.level === 'string', JSON.stringify(qualityPayload.quality))
  check('录音质量带中文建议', Array.isArray(qualityPayload.quality?.suggestions) && qualityPayload.quality.suggestions.length > 0, JSON.stringify(qualityPayload.quality?.suggestions))

  // ASR 热词：切到腾讯云后，术语表会作为 hotwords 传进 transcribeCloud
  const hotwordCaptured = {}
  const askHotwords = await runRoute({
    status: () => ({ available: true, providers: [], selection: {} }),
    prepare: () => {},
    async transcribeWav() { return { text: '', audioSeconds: 0 }; },
  }, {
    cloudAsr: {
      async transcribeCloud(args) {
        hotwordCaptured.args = args
        return { ok: true, text: '云端识别结果' }
      },
    },
  })
  await askHotwords('PATCH', '/dsh-meeting/settings', JSON.stringify({ settings: { transcribe: { provider: 'cloud-tencent' }, terms: '智慧工地平台\nBIM' } }), 'application/json')
  const hotwordTranscribe = await askHotwords('POST', '/dsh-meeting/meetings/mt_test/transcribe?language=zh', makeWav(2))
  check('云端转写会把术语表作为热词传入', hotwordTranscribe.status === 200 && Array.isArray(hotwordCaptured.args?.hotwords) && hotwordCaptured.args.hotwords.includes('智慧工地平台') && hotwordCaptured.args.hotwords.includes('BIM'), JSON.stringify(hotwordCaptured.args?.hotwords))
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);



