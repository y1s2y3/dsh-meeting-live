/**
 * 离线测试：说话人标记的持久化（S1/S2 与 A/B/C/D 都要能存下来）。
 *
 * 背景（2026-11-17）：`normalizeMeeting` 之前只允许单个 A-Z 的说话人标记，
 * 声纹分离写回的 `S1/S2…` 被静默清成空串 —— 表现为「点了重新分离说话人、跑了十分钟、结果什么都没有」。
 *
 * 用法：node tests/smoke-speaker-labels.mjs [插件目录]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const installedDir = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-meeting-live')
const pluginDir = process.argv[2] ?? (fs.existsSync(path.join(repoRoot, 'src', 'lib', 'model.js')) ? path.join(repoRoot, 'src') : installedDir)
const model = await import(pathToFileURL(path.join(pluginDir, 'lib', 'model.js')).href)
const { normalizeMeeting, normalizeSpeakerLabel, normalizeSpeakerNames } = model

let failures = 0
function check(label, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ← ' + detail}`)
  if (!condition) failures += 1
}

/* 1. 标记白名单 */
{
  check('A-Z 合法（音高估算）', normalizeSpeakerLabel('A') === 'A' && normalizeSpeakerLabel('D') === 'D')
  check('S1/S12/S999 合法（声纹分离）', normalizeSpeakerLabel('S1') === 'S1'
    && normalizeSpeakerLabel('S12') === 'S12' && normalizeSpeakerLabel('S999') === 'S999')
  check('单个大写字母 S 是旧的音高标签，仍然合法', normalizeSpeakerLabel('S') === 'S')
  check('非法标记被清空', normalizeSpeakerLabel('张三') === ''
    && normalizeSpeakerLabel('s1') === '' && normalizeSpeakerLabel('S1234') === '' && normalizeSpeakerLabel('S0') === '' && normalizeSpeakerLabel('') === '')
}

/* 2. 分段里的 S1/S2 必须原样保存（这是之前的 bug） */
{
  const raw = {
    title: '巡检隐患流程与抽查功能评审',
    date: '2026-11-17',
    transcript: 'S1：第一句\nS2：第二句\nS1：第三句',
    transcriptSegments: [
      { speaker: 'S1', text: '第一句', at: 0 },
      { speaker: 'S2', text: '第二句', at: 30 },
      { speaker: 'S1', text: '第三句', at: 60 },
      { speaker: 'A', text: '第四句', at: 90 },
      { speaker: '张三', text: '第五句', at: 120 },
      { speaker: '', text: '第六句', at: 150 },
    ],
  }
  const meeting = normalizeMeeting(raw)
  const labels = meeting.transcriptSegments.map((segment) => segment.speaker)
  check('S1/S2 标签写入后仍存在', labels[0] === 'S1' && labels[1] === 'S2' && labels[2] === 'S1', JSON.stringify(labels))
  check('A-Z 标签仍兼容', labels[3] === 'A')
  check('非法说话人标记被清空', labels[4] === '', JSON.stringify(labels[4]))
  check('无标签段落保持空', labels[5] === '')
  check('段落数量不被意外截断', meeting.transcriptSegments.length === 6, String(meeting.transcriptSegments.length))
}

/* 3. 说话人重命名：S1 → 真实姓名也要能保存 */
{
  const names = normalizeSpeakerNames({ S1: '安莉', S2: '荣旺', A: '张三', '张三': '非法', '': '空' })
  check('S1/S2 重命名可保存', names.S1 === '安莉' && names.S2 === '荣旺', JSON.stringify(names))
  check('A-Z 重命名仍兼容', names.A === '张三')
  check('非法 key 被忽略', names['张三'] === undefined && names[''] === undefined)
  const meeting = normalizeMeeting({ title: 'x', date: '2026-11-17', speakerNames: { S1: '安莉' } })
  check('会议归一化保留 S1 姓名', meeting.speakerNames.S1 === '安莉', JSON.stringify(meeting.speakerNames))
}

/* 4. 长会议（156 段）不会被截断 */
{
  const segments = Array.from({ length: 156 }, (_, index) => ({ speaker: 'S' + String((index % 4) + 1), text: '第 ' + String(index) + ' 段', at: index * 30 }))
  const meeting = normalizeMeeting({ title: 'x', date: '2026-11-17', transcriptSegments: segments })
  check('156 段全部保留', meeting.transcriptSegments.length === 156, String(meeting.transcriptSegments.length))
  check('156 段的 S 标签都在', meeting.transcriptSegments.every((segment) => /^S\d+$/.test(segment.speaker)))
}

console.log('')
if (failures > 0) {
  console.error(`FAILED: ${failures} case(s)`)
  process.exit(1)
}
console.log('ALL SPEAKER LABEL CHECKS PASSED')
