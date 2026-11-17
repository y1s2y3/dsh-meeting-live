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
const { relabelSegmentsBySpeaker, buildTranscriptFromSegments } = await import(pathToFileURL(path.join(pluginDir, 'lib', 'server.js')).href)

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

console.log('')
if (failures > 0) {
  console.error(`FAILED: ${failures} case(s)`)
  process.exit(1)
}
console.log('ALL DIARIZE LABEL CHECKS PASSED')
