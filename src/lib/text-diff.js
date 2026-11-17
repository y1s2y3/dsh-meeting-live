/**
 * 转写纠错的「逐行对比」与「按选中项应用」。
 * 只做行级 diff，足够覆盖 LLM 纠错（保持换行的）场景；不依赖第三方库。
 *
 * @module dsh-meeting-live/text-diff
 */

function splitLines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
}

/**
 * 对比原文与纠错稿，返回有变化的行。
 * @returns `[{ index, before, after }]`：index 指向原文行号；before='' 表示新增行，after='' 表示删除行。
 */
export function diffTextLines(original, corrected) {
  const a = splitLines(original)
  const b = splitLines(corrected)
  if (a.length === 0 || b.length === 0) return []
  if (a.length === b.length) {
    const changes = []
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] === b[index]) continue
      changes.push({ index, before: a[index], after: b[index] })
    }
    return changes
  }
  // 行数不同：做 LCS 对齐（限制规模，避免超大文本卡顿）
  const maxLines = 800
  if (a.length > maxLines || b.length > maxLines) {
    const changes = []
    const length = Math.min(a.length, b.length)
    for (let index = 0; index < length; index += 1) {
      if (a[index] !== b[index]) changes.push({ index, before: a[index], after: b[index] })
    }
    for (let index = length; index < a.length; index += 1) changes.push({ index, before: a[index], after: '' })
    for (let index = length; index < b.length; index += 1) changes.push({ index, before: '', after: b[index] })
    return changes
  }
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  // 回溯成 op 序列（del / ins / equal）
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'equal', a: i, b: j })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'del', a: i })
      i += 1
    } else {
      ops.push({ kind: 'ins', b: j })
      j += 1
    }
  }
  while (i < n) { ops.push({ kind: 'del', a: i }); i += 1 }
  while (j < m) { ops.push({ kind: 'ins', b: j }); j += 1 }

  const changes = []
  let cursor = 0
  while (cursor < ops.length) {
    if (ops[cursor].kind === 'equal') { cursor += 1; continue }
    const dels = []
    const inss = []
    while (cursor < ops.length && ops[cursor].kind !== 'equal') {
      if (ops[cursor].kind === 'del') dels.push(ops[cursor].a)
      else inss.push(ops[cursor].b)
      cursor += 1
    }
    const paired = Math.min(dels.length, inss.length)
    for (let k = 0; k < paired; k += 1) changes.push({ index: dels[k], before: a[dels[k]], after: b[inss[k]] })
    for (let k = paired; k < dels.length; k += 1) changes.push({ index: dels[k], before: a[dels[k]], after: '' })
    for (let k = paired; k < inss.length; k += 1) changes.push({ index: dels.length > 0 ? dels[dels.length - 1] + 1 : 0, before: '', after: b[inss[k]] })
  }
  return changes
}

/**
 * 按「勾选接受的行」重建正文：接受的行替换为纠错稿，未接受保留原文。
 * @param original - 原文。
 * @param changes - diffTextLines 的结果。
 * @param acceptedIndexes - 接受的 change 下标（对应 changes 数组）。
 */
export function applyCorrectionChanges(original, changes, acceptedIndexes) {
  const lines = splitLines(original)
  const accepted = new Set(Array.isArray(acceptedIndexes) ? acceptedIndexes : [])
  const selected = (Array.isArray(changes) ? changes : [])
    .map((change, index) => ({ ...change, selectedIndex: index }))
    .filter((change) => accepted.has(change.selectedIndex))
  const inserts = []
  let fallbackCursor = 0
  const sorted = selected.slice().sort((left, right) => {
    const leftIndex = Number.isInteger(left.index) ? left.index : Number.MAX_SAFE_INTEGER
    const rightIndex = Number.isInteger(right.index) ? right.index : Number.MAX_SAFE_INTEGER
    return rightIndex - leftIndex
  })
  for (const change of sorted) {
    let index = Number.isInteger(change.index) ? change.index : -1
    if (index < 0 && change.before !== '') {
      // 旧数据可能没存 index：按顺序在原文里找这一行
      const found = lines.findIndex((line, lineIndex) => lineIndex >= fallbackCursor && line === change.before)
      if (found >= 0) { index = found; fallbackCursor = found + 1 }
    }
    if (change.before === '') { inserts.push({ ...change, index: index >= 0 ? index : lines.length }); continue }
    if (change.after === '') {
      if (index >= 0 && index < lines.length) lines.splice(index, 1)
      continue
    }
    if (index >= 0 && index < lines.length) lines[index] = change.after
  }
  inserts.sort((left, right) => left.index - right.index)
  for (const change of inserts) {
    lines.splice(Math.max(0, Math.min(change.index, lines.length)), 0, change.after)
  }
  return lines.join('\n')
}
