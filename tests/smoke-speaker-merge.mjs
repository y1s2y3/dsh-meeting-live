/**
 * 离线测试：「相近音色二次合并」（speaker-merge.js）。
 *
 * 背景：pyannote + cam++ 自动聚类会把同一个人拆成多个簇（实测 2 人的会分出 4–16 个说话人）。
 * 这里用每个说话人的声纹质心做余弦相似度合并，规则：
 *   - 只有双方累计语音 ≥20 秒才允许合并（避免把一声「嗯」当人）；
 *   - 时长 <20 秒的小簇直接并进最相似的大簇；
 *   - 合并后按时长重新编号 S1..Sk。
 *
 * 用法：node tests/smoke-speaker-merge.mjs [插件目录]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const installedDir = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-meeting-live')
const pluginDir = process.argv[2] ?? (fs.existsSync(path.join(repoRoot, 'src', 'lib', 'speaker-merge.js')) ? path.join(repoRoot, 'src') : installedDir)
const { mergeSpeakerClusters, describeMerge, cosineSimilarity } = await import(pathToFileURL(path.join(pluginDir, 'lib', 'speaker-merge.js')).href)

let failures = 0
function check(label, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ← ' + detail}`)
  if (!condition) failures += 1
}

/** 生成与 [1,0] 夹角为 angle 的单位向量（用来精确控制余弦相似度）。 */
function unit(angle) {
  return [Math.cos(angle), Math.sin(angle)]
}
function linesOf(spec) {
  // spec: [{ speaker, seconds }] → 每句 10 秒的 lines（末尾补齐）
  const lines = []
  for (const item of spec) {
    let remaining = item.seconds
    let start = 0
    while (remaining > 0) {
      const seconds = Math.min(10, remaining)
      lines.push({ speaker: item.speaker, start, end: start + seconds, text: item.speaker + '说' })
      start += seconds
      remaining -= seconds
    }
  }
  return lines
}

/* 1. 同一个人被拆成三个簇：合并成一人；另一个不同的人保留 */
{
  const lines = linesOf([
    { speaker: 'S1', seconds: 100 },
    { speaker: 'S2', seconds: 30 },
    { speaker: 'S3', seconds: 60 },
    { speaker: 'S4', seconds: 25 },
  ])
  const centers = {
    S1: unit(0),
    S2: unit(1.4),
    S3: unit(1.35),
    S4: unit(1.45),
  }
  check('同一簇对的相似度确实 >0.99', cosineSimilarity(centers.S2, centers.S3) > 0.99, cosineSimilarity(centers.S2, centers.S3).toFixed(4))
  check('与另一个人相似度 <0.2', cosineSimilarity(centers.S1, centers.S2) < 0.2, cosineSimilarity(centers.S1, centers.S2).toFixed(4))
  const result = mergeSpeakerClusters({ lines, centers, threshold: 0.68 })
  check('4 个簇合并成 2 人', result.merged === true && result.after === 2, JSON.stringify({ before: result.before, after: result.after }))
  check('被合并的簇都指向同一个新标签', result.lines.filter((line) => ['S2', 'S3', 'S4'].includes(line.speaker) === false).length > 0
    && new Set(result.lines.map((line) => line.speaker)).size === 2, JSON.stringify([...new Set(result.lines.map((line) => line.speaker))]))
  const mergedGroup = result.groups.find((group) => group.from.length === 3)
  const soloGroup = result.groups.find((group) => group.from.length === 1)
  check('按时长重新编号：合计 115 秒的合并组成为 S1', mergedGroup?.label === 'S1' && soloGroup?.label === 'S2', JSON.stringify(result.groups))
  check('保留原有额外字段（text）', result.lines.every((line) => typeof line.text === 'string' && line.text !== ''))
  check('合并说明是人话', describeMerge(result).includes('4 → 2 人') && describeMerge(result).includes('S1←S2+S3+S4'), describeMerge(result))
}

/* 2. 阈值拉高则不合并 */
{
  const lines = linesOf([{ speaker: 'S1', seconds: 100 }, { speaker: 'S2', seconds: 30 }, { speaker: 'S3', seconds: 60 }])
  const centers = { S1: unit(0), S2: unit(1.4), S3: unit(1.35) }
  const strict = mergeSpeakerClusters({ lines, centers, threshold: 0.9999 })
  check('阈值 0.9999 时不再合并', strict.merged === false && strict.after === 3, JSON.stringify({ after: strict.after }))
  const loose = mergeSpeakerClusters({ lines, centers, threshold: 0.62 })
  check('阈值 0.62 时合并', loose.merged === true && loose.after === 2, JSON.stringify({ after: loose.after }))
}

/* 3. 小簇（<20 秒）不独立成人，并进最相似的大簇 */
{
  const lines = linesOf([
    { speaker: 'S1', seconds: 200 },
    { speaker: 'S2', seconds: 120 },
    { speaker: 'S9', seconds: 6 }, // 只说了两句话的噪声簇
  ])
  const centers = { S1: unit(0), S2: unit(1.4), S9: unit(1.42) }
  const result = mergeSpeakerClusters({ lines, centers, threshold: 0.68 })
  check('小簇被并入最相似的大簇（仍是 2 人）', result.merged === true && result.after === 2, JSON.stringify({ after: result.after, groups: result.groups }))
  const absorbed = result.groups.find((group) => group.from.includes('S9'))
  check('小簇被并进最相似的大簇所在分组', absorbed !== undefined && absorbed.from.includes('S2') === true, JSON.stringify(absorbed))
}

/* 4. 没有质心 / 只有一个说话人时原样返回 */
{
  const lines = linesOf([{ speaker: 'S1', seconds: 60 }, { speaker: 'S2', seconds: 30 }])
  const noCenters = mergeSpeakerClusters({ lines, centers: null })
  check('没有质心时不合并也不报错', noCenters.merged === false && noCenters.lines.length === lines.length)
  const single = mergeSpeakerClusters({ lines: linesOf([{ speaker: 'S1', seconds: 60 }]), centers: { S1: unit(0) } })
  check('只有一个说话人时直接返回', single.merged === false && single.after === 1)
  check('空输入安全', mergeSpeakerClusters({ lines: [], centers: {} }).after === 0)
}

/* 5. 合并后每句的说话人都在新编号范围内 */
{
  const lines = linesOf([
    { speaker: 'S1', seconds: 90 },
    { speaker: 'S2', seconds: 40 },
    { speaker: 'S3', seconds: 40 },
  ])
  const centers = { S1: unit(2.8), S2: unit(0.3), S3: unit(0.32) }
  const result = mergeSpeakerClusters({ lines, centers, threshold: 0.68 })
  const labels = new Set(result.lines.map((line) => line.speaker))
  check('合并后标签只含 S1..Sk', [...labels].every((label) => /^S[1-9]\d?$/.test(label)), JSON.stringify([...labels]))
  check('句数不变（只改标签不改结构）', result.lines.length === lines.length)
}

console.log('')
if (failures > 0) {
  console.error(`FAILED: ${failures} case(s)`)
  process.exit(1)
}
console.log('ALL SPEAKER MERGE CHECKS PASSED')
