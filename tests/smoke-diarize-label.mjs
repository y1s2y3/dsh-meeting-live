/**
 * 离线测试：声纹分离结果 → 已有转写分段的标签回填。
 *
 * 场景：转写分段自带时间（at=距录音开始秒数），声纹分离给出 S1/S2 的时间区间；
 * 要求按时间把 S 标签回填到分段上（保留原文与时间），并重建带说话人的转写文本。
 *
 * 用法：node tests/smoke-diarize-label.mjs [插件目录]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const installedDir = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-meeting-live')
const pluginDir = process.argv[2] ?? (fs.existsSync(path.join(repoRoot, 'src', 'lib', 'server.js')) ? path.join(repoRoot, 'src') : installedDir)
const { relabelSegmentsBySpeaker, buildTranscriptFromSegments, diarizeCacheKey, readDiarizeCache, writeDiarizeCache, applyTurnLines } = await import(pathToFileURL(path.join(pluginDir, 'lib', 'server.js')).href)

let failures = 0
function check(label, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ← ' + detail}`)
  if (!condition) failures += 1
}

/* 1. 命中区间：按时间把 S1/S2 贴到分段上，文字与时间不变 */
{
  const segments = [
    { speaker: '', text: '第一段', at: 3 },
    { speaker: '', text: '第二段', at: 40 },
    { speaker: '', text: '第三段', at: 95 },
    { speaker: '', text: '第四段', at: 150 },
  ]
  const lines = [
    { speaker: 'S1', text: 'a', start: 0, end: 25 },
    { speaker: 'S2', text: 'b', start: 30, end: 80 },
    { speaker: 'S1', text: 'c', start: 90, end: 130 },
    { speaker: 'S3', text: 'd', start: 140, end: 200 },
  ]
  const result = relabelSegmentsBySpeaker(segments, lines)
  check('全部段落都拿到说话人标签', result.assigned === 4 && result.total === 4, JSON.stringify({ assigned: result.assigned, total: result.total }))
  check('标签按时间顺序正确', result.segments.map((s) => s.speaker).join(',') === 'S1,S2,S1,S3', result.segments.map((s) => s.speaker).join(','))
  check('文字与时间保持不变', result.segments.every((s, i) => s.text === segments[i].text && s.at === segments[i].at))
}

/* 2. 边界容差与最近起点兜底：切片边界/静音导致 at 落在区间外也能贴回 */
{
  const segments = [
    { speaker: '', text: '边界前2秒', at: 28 },   // 区间 30-50，容差内
    { speaker: '', text: '边界后2秒', at: 52 },   // 区间 30-50，容差内
    { speaker: '', text: '接近起点', at: 63 },    // 区间 60-90，命中
    { speaker: '', text: '离得远', at: 300 },     // 没有区间，保持空
  ]
  const lines = [
    { speaker: 'S1', text: 'x', start: 30, end: 50 },
    { speaker: 'S2', text: 'y', start: 60, end: 90 },
  ]
  const result = relabelSegmentsBySpeaker(segments, lines)
  check('时间区间前后 2 秒容差生效', result.segments[0].speaker === 'S1' && result.segments[1].speaker === 'S1',
    JSON.stringify(result.segments.map((s) => s.speaker)))
  check('正常命中不误判', result.segments[2].speaker === 'S2')
  check('远离所有区间保持无标签', result.segments[3].speaker === '', JSON.stringify(result.segments[3]))
}

/* 2.b 20 秒最近起点容差 + 相邻段沿用（减少「空标签」） */
{
  const segments = [
    { speaker: '', text: '离区间起点 15 秒', at: 15 },
    { speaker: '', text: '命中第一段', at: 35 },
    { speaker: '', text: '长静音后的一段', at: 50 },
    { speaker: '', text: '很远', at: 400 },
  ]
  const lines = [{ speaker: 'S2', text: 'x', start: 30, end: 45 }]
  const result = relabelSegmentsBySpeaker(segments, lines)
  check('20 秒内按最近起点兜底', result.segments[0].speaker === 'S2', JSON.stringify(result.segments.map((s) => s.speaker)))
  check('命中区间正常', result.segments[1].speaker === 'S2')
  check('相邻分段沿用前一说话人（不再留空）', result.segments[2].speaker === 'S2', JSON.stringify(result.segments.map((s) => s.speaker)))
  check('远离且无相邻标签仍留空', result.segments[3].speaker === '', JSON.stringify(result.segments[3].speaker))
}

/* 3. 空输入 / 缺失字段安全 */
{
  const none = relabelSegmentsBySpeaker([], [])
  check('无分段时返回 null 结果', none.segments === null && none.assigned === 0)
  const noLines = relabelSegmentsBySpeaker([{ text: 'a', at: 0 }], [])
  check('没有声纹区间时返回 null 结果', noLines.segments === null)
  const bad = relabelSegmentsBySpeaker([{ text: 'a' }, null], [{ speaker: '', start: 0, end: 10 }, { speaker: 'S1', start: null }])
  check('非法数据不抛错', bad.segments === null || Array.isArray(bad.segments))
}

/* 4. 由分段重建转写文本：有标签加「S1：」，无标签保持纯文本 */
{
  const text = buildTranscriptFromSegments([
    { speaker: 'S1', text: '第一句', at: 0 },
    { speaker: '', text: '第二句', at: 30 },
    { speaker: 'S2', text: '第三句', at: 60 },
  ])
  check('重建文本带说话人标记', text === 'S1：第一句\n第二句\nS2：第三句', JSON.stringify(text))
}

/* 5. 连续多段同一人：标签一致（用于按人聚合展示） */
{
  const segments = [
    { speaker: '', text: 'a', at: 5 },
    { speaker: '', text: 'b', at: 15 },
    { speaker: '', text: 'c', at: 25 },
  ]
  const lines = [{ speaker: 'S4', text: 'x', start: 0, end: 30 }]
  const result = relabelSegmentsBySpeaker(segments, lines)
  check('同一说话人区间内多段标签一致', result.segments.every((s) => s.speaker === 'S4'), result.segments.map((s) => s.speaker).join(','))
}

/* 6. 声纹分离结果缓存：同一段音频重试时直接复用，不用再跑十分钟 */
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-diarize-cache-'))
  const audioPath = path.join(tmpDir, 'meeting.wav')
  fs.writeFileSync(audioPath, 'fake-audio-bytes')
  const key1 = diarizeCacheKey(audioPath)
  check('缓存键稳定（同文件同键）', key1 !== '' && key1 === diarizeCacheKey(audioPath), key1)
  const lines = [{ speaker: 'S1', start: 0, end: 10 }, { speaker: 'S2', start: 10, end: 20 }]
  const written = await writeDiarizeCache(audioPath, { numClusters: 4, speakers: 2, lines }, tmpDir)
  check('写入缓存成功', written === true)
  const cached = await readDiarizeCache(audioPath, tmpDir)
  check('读回缓存的说话人数与区间', cached?.speakers === 2 && cached?.lines?.length === 2 && cached?.numClusters === 4, JSON.stringify(cached?.speakers))
  // 音频变化后键会变（换文件等同换内容）
  const otherPath = path.join(tmpDir, 'other.wav')
  fs.writeFileSync(otherPath, 'another-bytes')
  check('不同音频的缓存键不同', diarizeCacheKey(otherPath) !== key1)
  check('没有缓存时返回 null', (await readDiarizeCache(otherPath, tmpDir)) === null)
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

/* 7. 按说话人切句（turns 模式）：一行一句、每句一个说话人，并保护原转写 */
{
  const meeting = { id: 'm-turn', transcript: '旧'.repeat(30), transcriptSegments: [] }
  const store = {
    get() { return meeting },
    async patch(id, patch) { Object.assign(meeting, patch); return meeting },
  }
  const job = {}
  const lines = [
    { speaker: 'S1', text: '第一句：这个抽查功能放最后说，先说巡检这边的改动，前后端都要加一个新增巡检任务的入口。', start: 0, end: 30 },
    { speaker: 'S2', text: '好的，那这个表单跟移动端是一样的是吧？我们这边也照着一模一样的方式来做。', start: 30, end: 60 },
    { speaker: '', text: '嗯（一段没有说话人标签的插话，保持原样）。', start: 60, end: 66 },
  ]
  await applyTurnLines({ store, meetingId: 'm-turn', lines, speakers: 2, job })
  check('切句后一行一句、带说话人前缀', meeting.transcript.split('\n').length === 3 && meeting.transcript.startsWith('S1：第一句'), meeting.transcript.slice(0, 40))
  check('切句后无标签的行保持原文', meeting.transcript.split('\n')[2].startsWith('嗯'), meeting.transcript.split('\n')[2].slice(0, 20))
  check('切句后分段带说话人与时间', meeting.transcriptSegments.length === 3
    && meeting.transcriptSegments[0].speaker === 'S1' && meeting.transcriptSegments[0].at === 0
    && meeting.transcriptSegments[1].speaker === 'S2', JSON.stringify(meeting.transcriptSegments.map((s) => [s.speaker, s.at])))
  check('切句完成提示人数与句数', String(job.note ?? '').includes('2 位说话人') && String(job.note ?? '').includes('3 句'), job.note)
  check('统计了每位说话人的段数', job.counts?.S1 === 1 && job.counts?.S2 === 1, JSON.stringify(job.counts))

  // 切句后文本明显变少时不能覆盖原转写
  const meeting2 = { id: 'm-turn2', transcript: '长'.repeat(1000) }
  let threw = null
  try {
    await applyTurnLines({
      store: { get() { return meeting2 }, async patch() { throw new Error('不该写入') } },
      meetingId: 'm-turn2',
      lines: [{ speaker: 'S1', text: '太短', start: 0 }],
      speakers: 1,
      job: {},
    })
  } catch (error) {
    threw = error
  }
  check('切句后文本过短时不覆盖原转写', threw !== null && String(threw.message).includes('已保留原转写'), threw === null ? '没有报错' : threw.message)
}

console.log('')
if (failures > 0) {
  console.error(`FAILED: ${failures} case(s)`)
  process.exit(1)
}
console.log('ALL DIARIZE LABEL CHECKS PASSED')
