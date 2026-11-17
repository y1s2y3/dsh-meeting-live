/**
 * 说话人「相近音色二次合并」。
 *
 * 背景：pyannote + cam++ 自动聚类在远场、抢话、音量起伏时，容易把**同一个人拆成多个簇**
 * （实测一场 2 人的会能分出 4–16 个说话人）。这里用每个回合的声纹向量求「每个簇的质心」，
 * 质心余弦相似度足够高就把两个簇合并回同一个人。
 *
 * 设计要点：
 *   - 只合并「双方都有足够语音（默认 ≥20 秒）」的簇，避免把一声「嗯」当成一个说话人；
 *   - 时长很小（<20 秒）的噪声簇不独立成人，直接并进质心最相似的大簇；
 *   - 合并后按累计语音时长重新编号 S1..Sk（主讲通常是 S1）；
 *   - 只依赖纯数据（lines + 质心），方便单测，也方便在没有 sherpa 的环境里跑。
 */

/**
 * 两个向量的余弦相似度。
 * @param a - 向量（数组或 Float32Array）。
 * @param b - 向量。
 * @returns -1..1 的相似度；任一为空时返回 0。
 */
export function cosineSimilarity(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return 0
  const length = Math.min(a.length, b.length)
  if (length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index]
    normA += a[index] * a[index]
    normB += b[index] * b[index]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** 把每段累计语音时长（秒）按说话人汇总。 */
function durationBySpeaker(lines) {
  const durations = new Map()
  for (const line of Array.isArray(lines) ? lines : []) {
    const speaker = typeof line?.speaker === 'string' ? line.speaker : ''
    if (speaker === '') continue
    const start = Number(line.start)
    const end = Number(line.end)
    const seconds = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0
    durations.set(speaker, (durations.get(speaker) ?? 0) + seconds)
  }
  return durations
}

/**
 * 按质心相似度合并相近说话人。
 *
 * @param options - `{ lines, centers, threshold, minClusterSeconds }`
 *   - lines：`[{ speaker, start, end, ... }]`，其余字段原样保留（切句模式带 text）。
 *   - centers：`{ S1: number[], S2: number[] }` 或 Map，来自分离子进程的逐说话人声纹质心。
 *   - threshold：余弦相似度阈值，默认 0.68；越大越保守（越不容易合并）。
 *   - minClusterSeconds：允许合并的最小簇时长，默认 20 秒。
 * @returns `{ lines, before, after, merged, groups }`
 *   - lines 是合并后的新数组；groups 形如 `[{ label: 'S1', from: ['S1','S3'], seconds }]`。
 */
export function mergeSpeakerClusters({ lines, centers, threshold = 0.68, minClusterSeconds = 20 }) {
  const rows = Array.isArray(lines) ? lines : []
  const centerMap = centers instanceof Map
    ? centers
    : new Map(Object.entries(centers !== null && typeof centers === 'object' ? centers : {}))
  const labels = [...new Set(rows.map((line) => (typeof line?.speaker === 'string' ? line.speaker : '')).filter((speaker) => speaker !== ''))]
  const empty = { lines: rows.slice(), before: labels.length, after: labels.length, merged: false, groups: [] }
  // 没有声纹质心（例如旧缓存 / 嵌入失败）：不合并，原样返回。
  const usable = [...centerMap.entries()].filter(([label, vector]) => labels.includes(label) && Array.isArray(vector) && vector.length > 0)
  if (labels.length < 2 || usable.length < 2) return empty
  const durations = durationBySpeaker(rows)
  const centroids = new Map(usable)
  const pairs = []
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      const first = labels[i]
      const second = labels[j]
      if (!centroids.has(first) || !centroids.has(second)) continue
      pairs.push({ a: first, b: second, similarity: cosineSimilarity(centroids.get(first), centroids.get(second)) })
    }
  }
  if (pairs.length === 0) return empty
  const parent = new Map(labels.map((label) => [label, label]))
  const find = (value) => {
    let current = value
    while (parent.get(current) !== current) {
      parent.set(current, parent.get(parent.get(current)))
      current = parent.get(current)
    }
    return current
  }
  for (const pair of pairs) {
    if (pair.similarity < threshold) continue
    if ((durations.get(pair.a) ?? 0) < minClusterSeconds) continue
    if ((durations.get(pair.b) ?? 0) < minClusterSeconds) continue
    const rootA = find(pair.a)
    const rootB = find(pair.b)
    if (rootA !== rootB) parent.set(rootA, rootB)
  }
  // 汇总成组
  const groupMap = new Map()
  for (const label of labels) {
    const root = find(label)
    if (!groupMap.has(root)) groupMap.set(root, { labels: [], seconds: 0 })
    const group = groupMap.get(root)
    group.labels.push(label)
    group.seconds += durations.get(label) ?? 0
  }
  const groups = [...groupMap.values()]
  const large = groups.filter((group) => group.seconds >= minClusterSeconds)
  const tiny = groups.filter((group) => group.seconds < minClusterSeconds)
  // 小簇并进最相似的大簇（避免「只说了两句话的人」）
  for (const group of tiny) {
    const representative = group.labels.find((label) => centroids.has(label))
    let best = null
    if (representative !== undefined) {
      for (const candidate of large) {
        const candidateLabel = candidate.labels.find((label) => centroids.has(label))
        if (candidateLabel === undefined) continue
        const similarity = cosineSimilarity(centroids.get(representative), centroids.get(candidateLabel))
        if (best === null || similarity > best.similarity) best = { candidate, similarity }
      }
    }
    if (best !== null) best.candidate.labels.push(...group.labels)
    else large.push(group)
  }
  // 按时长从大到小重新编号 S1..Sk
  large.sort((a, b) => b.seconds - a.seconds)
  const labelMap = new Map()
  const reported = large.map((group, index) => {
    const label = 'S' + String(index + 1)
    for (const old of group.labels) labelMap.set(old, label)
    return { label, from: group.labels.slice().sort(), seconds: Math.round(group.seconds) }
  })
  const nextLines = rows.map((line) => {
    const speaker = typeof line?.speaker === 'string' ? line.speaker : ''
    const mapped = labelMap.get(speaker)
    return mapped === undefined || mapped === speaker ? { ...line } : { ...line, speaker: mapped }
  })
  return {
    lines: nextLines,
    before: labels.length,
    after: reported.length,
    merged: reported.length < labels.length,
    groups: reported,
  }
}

/**
 * 把合并结果写成一句人话，给任务状态/说明用。
 * @param merge - `mergeSpeakerClusters` 的返回值。
 * @returns 例如「相近音色合并：8 → 3 人（S1←S1+S3；S2←S2+S8）」；没有合并时为空串。
 */
export function describeMerge(merge) {
  if (merge === null || merge === undefined || merge.merged !== true) return ''
  const detail = (Array.isArray(merge.groups) ? merge.groups : [])
    .filter((group) => Array.isArray(group.from) && group.from.length > 1)
    .map((group) => group.label + '←' + group.from.join('+'))
    .join('；')
  return '相近音色合并：' + String(merge.before) + ' → ' + String(merge.after) + ' 人' + (detail === '' ? '' : '（' + detail + '）')
}
