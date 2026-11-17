/**
 * 离线测试：转写准确率提升相关的纯逻辑与界面入口
 *   - 录音质量分析（音量/削波/信噪比/静音）
 *   - 纠错 diff（逐行对比、按勾选应用）
 *   - 会议字段：speakerNames / audioQuality / correction 归一化
 *   - 纠错 prompt 使用说话人姓名；导出带说话人映射
 *   - 前端：质量提示、说话人重命名、纠错审阅、两个设置开关
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (file) => import(pathToFileURL(path.join(repo, 'src', 'lib', file)).href);
const quality = await imp('audio-quality.js');
const diff = await imp('text-diff.js');
const model = await imp('model.js');
const summarize = await imp('summarize.js');
const exportLib = await imp('export.js');
const settingsLib = await imp('settings.js');

let failures = 0;
function check(label, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ← ' + detail}`);
  if (!condition) failures += 1;
}

/** 造一段 16k 单声道 PCM16 WAV。 */
function makeWav(samples) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples.length * 2, 40);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], 44 + index * 2);
  return buffer;
}

/* 1. 录音质量分析 */
{
  const quiet = new Int16Array(16000)
  for (let index = 0; index < quiet.length; index += 1) quiet[index] = Math.round((Math.random() * 2 - 1) * 20)
  const quietResult = quality.analyzeWavQuality(makeWav(quiet))
  check('几乎无声的录音判为较差', quietResult !== null && quietResult.level === 'poor', quietResult?.level)
  check('较差录音给出中文建议', quietResult !== null && quietResult.suggestions.length > 0 && quietResult.suggestions[0].includes('听不到'), quietResult?.suggestions[0])

  const speech = new Int16Array(16000)
  for (let index = 0; index < speech.length; index += 1) {
    const t = index / 16000
    const voiced = t % 1 < 0.6 // 0~0.6s 说话、0.6~1s 停顿，模拟真实会议
    speech[index] = voiced
      ? Math.round((Math.sin(2 * Math.PI * 220 * t) * 0.35 + (Math.random() * 2 - 1) * 0.01) * 32767)
      : Math.round((Math.random() * 2 - 1) * 30)
  }
  const speechResult = quality.analyzeWavQuality(makeWav(speech))
  check('正常音量、有停顿的测试音判为良好', speechResult !== null && speechResult.level === 'good', JSON.stringify(speechResult?.metrics))
  check('质量指标齐全（RMS/峰值/信噪比/削波/静音）', speechResult !== null && Number.isFinite(speechResult.metrics.rmsDbfs) && Number.isFinite(speechResult.metrics.snrDb) && Number.isFinite(speechResult.metrics.clippingRatio) && Number.isFinite(speechResult.metrics.silenceRatio), JSON.stringify(speechResult?.metrics))
  const clipped = new Int16Array(16000).fill(32767)
  const clippedResult = quality.analyzeWavQuality(makeWav(clipped))
  check('持续爆音判为较差并提示削波', clippedResult !== null && clippedResult.level === 'poor' && clippedResult.suggestions.some((item) => item.includes('爆音')), JSON.stringify(clippedResult?.suggestions))
  check('非 PCM16 WAV 返回 null', quality.analyzeWavQuality(Buffer.from('not wav')) === null)
}

/* 2. 纠错 diff：逐行对比 + 应用选中 */
{
  const before = '第一行\n第二行有错字\n第三行'
  const after = '第一行\n第二行有错别字\n第三行'
  const changes = diff.diffTextLines(before, after)
  check('diff 找出改动的行', changes.length === 1 && changes[0].index === 1 && changes[0].before.includes('错字') && changes[0].after.includes('错别字'), JSON.stringify(changes))
  check('接受修改后替换该行', diff.applyCorrectionChanges(before, changes, [0]) === after, diff.applyCorrectionChanges(before, changes, [0]))
  check('不接受修改时保持原文', diff.applyCorrectionChanges(before, changes, []) === before)
  const insertChanges = diff.diffTextLines('第一行\n第三行', '第一行\n第二行\n第三行')
  check('行数变化也能对齐（新增行）', insertChanges.length >= 1 && diff.applyCorrectionChanges('第一行\n第三行', insertChanges, insertChanges.map((item, index) => index)).includes('第二行'), JSON.stringify(insertChanges))
}

/* 3. 会议字段归一化 */
{
  const meeting = model.normalizeMeeting({
    title: '测试会议',
    speakerNames: { A: '张三', B: '', C: '李四', invalid: '王五' },
    audioQuality: { level: 'poor', summary: '声音太小', suggestions: ['靠近麦克风'], metrics: { rmsDbfs: -42.5, snrDb: 9 } },
    correction: { at: '2026-11-17T03:00:00.000Z', original: '第一行\n第二行', corrected: '第一行\n第二行改', changes: [{ before: '第二行', after: '第二行改' }] },
  })
  check('说话人重命名只保留 A-Z 且去空', JSON.stringify(meeting.speakerNames) === JSON.stringify({ A: '张三', C: '李四' }), JSON.stringify(meeting.speakerNames))
  check('录音质量字段保留等级与建议', meeting.audioQuality.level === 'poor' && meeting.audioQuality.suggestions[0] === '靠近麦克风')
  check('纠错待审阅字段保留', meeting.correction !== null && meeting.correction.changes.length === 1)
}

/* 4.1 上下文增强纠错：挑相关历史会议结论 */
{
  const context = model.buildCorrectionContext([
    { id: 'old-1', title: '机场平台周会', date: '2026-11-10', attendees: ['张三', '李四'], updatedAt: '2026-11-10T10:00:00Z', summary: { oneLine: '确认了 BIM 协调机制', decisions: ['上线时间定在 12 月'] } },
    { id: 'old-2', title: '无关会议', date: '2026-11-09', attendees: ['王五'], updatedAt: '2026-11-09T10:00:00Z', summary: { oneLine: '别的项目' } },
    { id: 'current', title: '当前会议', date: '2026-11-17', attendees: ['张三'], summary: { oneLine: '自己' } },
    { id: 'no-summary', title: '没纪要', date: '2026-11-16', attendees: ['张三'] },
  ], { id: 'current', attendees: ['张三', '李四'] })
  check('纠错上下文优先同参会人的历史会议', context.includes('机场平台周会') && context.includes('BIM 协调机制') && !context.includes('当前会议') && !context.includes('没纪要'), context)
  check('纠错上下文带决策摘要', context.includes('上线时间定在 12 月'))
}

/* 4.2 纪要模板 / 周报 prompt */
{
  check('纪要模板含评审/周会/客户/复盘', ['review', 'weekly', 'client', 'retro'].every((key) => typeof summarize.TEMPLATE_INSTRUCTIONS[key] === 'string' && summarize.TEMPLATE_INSTRUCTIONS[key].length > 10))
  check('未知模板回退通用', summarize.templateInstruction('unknown') === summarize.TEMPLATE_INSTRUCTIONS.general)
  const normalized = settingsLib.normalizeSettings ? null : null
  const digestPrompt = summarize.buildDigestUserPrompt([
    { title: '机场平台周会', date: '2026-11-10', summary: { oneLine: '确认 BIM 机制', decisions: ['12 月上线'], todos: [{ title: '补供应商清单', owner: '张三', due: '2026-11-20', calendarTaskId: 'ct1' }] } },
  ], '近 7 天')
  check('周报 prompt 汇总会议、决策与待办状态', digestPrompt.includes('机场平台周会') && digestPrompt.includes('12 月上线') && digestPrompt.includes('补供应商清单') && digestPrompt.includes('已写入待办'), digestPrompt)
  check('周报 system prompt 有固定结构', summarize.DIGEST_PROMPT.includes('本周概览') && summarize.DIGEST_PROMPT.includes('待办进展') && summarize.DIGEST_PROMPT.includes('下周建议'))
}

/* 4.3 纪要风格设置归一化 */
{
  const settings = settingsLib.normalizeSettings({
    summaryTemplate: 'review',
    summary: { mode: 'dsh' },
  })
  check('纪要风格写入设置', settings.summaryTemplate === 'review', settings.summaryTemplate)
  const fallback = settingsLib.normalizeSettings({ summaryTemplate: 'not-a-template', summary: { mode: 'dsh' } })
  check('非法纪要风格回退通用', fallback.summaryTemplate === 'general', fallback.summaryTemplate)
}
{
  const prompt = summarize.buildUserPrompt({
    title: '测试', date: '2026-11-17', attendees: [], notes: '', transcript: 'S1：你好',
    speakerNames: { S1: '张三' }, transcriptSegments: [{ speaker: 'S1', text: '你好' }],
  })
  check('纪要 prompt 带说话人对应关系', prompt.includes('S1=张三') && prompt.includes('speakerSummaries'), prompt.slice(0, 120))
  const md = exportLib.buildMarkdown(model.normalizeMeeting({
    title: '测试', date: '2026-11-17', speakerNames: { A: '张三' },
    transcript: 'A：你好', summary: null,
  }))
  check('Markdown 导出带说话人映射', md.includes('说话人：A = 张三'), md.slice(0, 160))
}

/* 5. 前端入口 */
{
  const client = fs.readFileSync(path.join(repo, 'src', 'lib', 'client.js'), 'utf8')
  check('录音质量提示与封面标签', client.includes('录音质量较差') && client.includes('录音质量：') && client.includes('audioQuality'))
  check('说话人重命名入口', client.includes('说话人重命名') && client.includes('onRenameSpeakers') && client.includes('保存姓名'))
  check('纠错逐行审阅与勾选', client.includes('转写纠错待确认') && client.includes('应用选中') && client.includes('dsm-diff-before'))
  check('设置页有审阅/预处理开关', client.includes('纠错后先审阅') && client.includes('音频预处理') && client.includes('reviewCorrections') && client.includes('preprocessAudio'))
  check('热词能力提示', client.includes('术语会作为热词传给云端识别') && client.includes('讯飞热词需在讯飞控制台'))
  check('设置页有纪要风格选择', client.includes('纪要风格') && client.includes('评审会（评审结论与修改项）') && client.includes('summaryTemplate'))
  check('工具栏周报入口与生成弹窗', client.includes('生成周报') && client.includes('DigestModal') && client.includes('/digest'))
  check('全文搜索入口与结果渲染', client.includes('搜索标题、参会人、转写、纪要') && client.includes('/search?q=') && client.includes('全文命中'))
  const server = fs.readFileSync(path.join(repo, 'src', 'lib', 'server.js'), 'utf8')
  check('云端识别会带术语热词', server.includes('hotwords: effectiveTerms(store.settings)'))
  check('纠错会带相关历史会议上下文', server.includes('buildCorrectionContext(store.snapshot().meetings'))
  check('总结会按设置传纪要风格', server.includes('template: settingsNow.summaryTemplate'))
  check('宿主有周报与全文搜索路由', server.includes("segments[0] === 'digest'") && server.includes("segments[0] === 'search'"))
  check('宿主有纠错应用/忽略路由', server.includes("segments[3] === 'apply'") && server.includes("segments[3] === 'discard'") && server.includes('applyCorrectionChanges'))
  check('会议 PATCH 支持 speakerNames', server.includes("'speakerNames'"))
  check('重转写会做音频预处理', server.includes('preprocessAudioWithFfmpeg'))
}

console.log(failures === 0 ? '\nALL ACCURACY TESTS PASSED' : `\n${failures} ACCURACY TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
