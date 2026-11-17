/**
 * Pure meeting model for the meeting-minutes plugin.
 *
 * Everything here is deterministic and free of filesystem, Cordis, or clock
 * reads other than the explicit `now` argument, so the whole module is
 * unit-testable under plain Node.
 *
 * @module dsh-meeting-live/model
 */

/** Where a meeting's text came from. */
export const SOURCE_TYPES = ['text', 'recording', 'import']
/** Stable priority vocabulary, shared with the task-calendar plugin. */
export const PRIORITIES = ['high', 'normal', 'low']
/** Risk levels used by the summary card. */
export const RISK_LEVELS = ['low', 'medium', 'high']

/** Short collision-resistant id. */
export function newId(prefix = 'mt') {
  const stamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${stamp}${random}`
}

/** Local calendar day key (`YYYY-MM-DD`) for a Date. */
export function localDay(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Full local clock label (`YYYY-MM-DD HH:mm`), used in prompts and exports. */
export function formatMoment(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${localDay(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Trim to text, or the fallback when the value is empty. */
export function asText(value, fallback = '') {
  if (value === undefined || value === null) return fallback
  const text = String(value).trim()
  return text === '' ? fallback : text
}

/** Cap a string without throwing, keeping the head. */
function capText(value, max) {
  const text = asText(value)
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * Parse one meeting date. Accepts `YYYY-MM-DD`, `YYYY/MM/DD`,
 * `YYYY年M月D日`, or a Date; falls back to today's local day.
 * @param value - raw input.
 * @param now - reference moment.
 * @returns `YYYY-MM-DD`.
 */
export function parseMeetingDate(value, now = new Date()) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return localDay(value)
  const text = asText(value)
  if (text === '') return localDay(now)
  const normalized = text
    .replace(/[年/.]/g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, '')
    .replace(/\s+/g, '')
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(normalized)
  if (match === null) return localDay(now)
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return localDay(now)
  const date = new Date(Number(match[1]), month - 1, day)
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return localDay(now)
  return localDay(date)
}

/** Normalize an attendee list from an array or one separated string. */
export function normalizeAttendees(value) {
  const raw = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/[,，、;；\n]+/) : [])
  const seen = new Set()
  const list = []
  for (const entry of raw) {
    const name = capText(entry, 40)
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    list.push(name)
    if (list.length >= 40) break
  }
  return list
}

/**
 * Is this title just the automatic placeholder the recorder/importer created?
 * Generic titles are safe for the summarizer to replace with an AI-named title;
 * a title the user typed is never overwritten automatically.
 * @param title - current meeting title.
 */
export function isGenericTitle(title) {
  const text = asText(title)
  if (text === '' || text === '未命名会议') return true
  return /^(录音纪要|会议纪要|导入纪要|语音纪要|会议记录)\s*$/u.test(text)
    || /^(录音纪要|会议纪要|导入纪要|语音纪要|会议记录)\s+\d{4}[-/]\d{1,2}[-/]\d{1,2}/u.test(text)
    || /^(录音纪要|会议纪要|导入纪要|语音纪要|会议记录)\s+\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}/u.test(text)
}

/** Clamp an arbitrary number into `[min, max]`, with a fallback. */
function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** Normalize a tag-like string list. */
function textList(value, max, maxLength = 400) {
  if (!Array.isArray(value)) return []
  const list = []
  for (const entry of value) {
    const text = capText(entry, maxLength)
    if (text !== '') list.push(text)
    if (list.length >= max) break
  }
  return list
}

/**
 * 概述排版：模型有时会把 400+ 字的概述写成一整段。
 * 没有空行时按句号切成 2-3 段，让阅读和导出（Word/HTML）更像腾讯会议/通义听悟的摘要。
 */
function formatOverviewParagraphs(value) {
  const raw = String(value ?? '').replace(/\r\n?/g, '\n').trim()
  if (raw === '' || raw.includes('\n')) return raw
  const sentences = raw.split(/(?<=[。！？；])/).map((item) => item.trim()).filter((item) => item !== '')
  if (sentences.length <= 2) return raw
  const total = raw.length
  const targetCount = total >= 480 ? 3 : (total >= 300 ? 2 : 1)
  if (targetCount <= 1) return raw
  const per = Math.ceil(total / targetCount)
  const paragraphs = []
  let current = ''
  for (const sentence of sentences) {
    current += sentence
    if (current.length >= per && paragraphs.length < targetCount - 1) {
      paragraphs.push(current)
      current = ''
    }
  }
  if (current !== '') paragraphs.push(current)
  return paragraphs.join('\n\n')
}

/** Normalize one todo produced by the model (before it gets an id). */
export function normalizeTodoInput(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const title = capText(input.title, 160)
  if (title === '') return null
  return {
    title,
    owner: capText(input.owner, 60),
    due: capText(input.due, 80),
    priority: PRIORITIES.includes(input.priority) ? input.priority : 'normal',
    notes: capText(input.notes, 800),
  }
}

/**
 * Normalize one complete todo, keeping the push bookkeeping of a matching
 * earlier todo so regenerating a summary never causes a duplicate calendar
 * entry for the same action item.
 * @param raw - model or stored todo.
 * @param previous - todos of the previous summary.
 */
function normalizeTodo(raw, previous = []) {
  const input = normalizeTodoInput(raw)
  if (input === null) return null
  const key = `${input.title}\u0000${input.owner}`
  const match = previous.find((todo) => `${todo.title}\u0000${todo.owner}` === key)
  // 弃用状态优先看本次输入（恢复时显式传 false），否则沿用同一条旧待办的状态。
  const dropped = typeof raw?.dropped === 'boolean' ? raw.dropped : match?.dropped === true
  const droppedAt = dropped
    ? (typeof raw?.droppedAt === 'string' && raw.droppedAt !== ''
      ? raw.droppedAt
      : (match?.droppedAt ?? null))
    : null
  return {
    id: asText(raw?.id, match?.id ?? newId('td')),
    title: input.title,
    owner: input.owner,
    due: input.due,
    priority: input.priority,
    notes: input.notes,
    calendarTaskId: match?.calendarTaskId ?? (typeof raw?.calendarTaskId === 'string' && raw.calendarTaskId !== '' ? raw.calendarTaskId : null),
    pushedAt: match?.pushedAt ?? (typeof raw?.pushedAt === 'string' ? raw.pushedAt : null),
    dropped,
    droppedAt,
  }
}

/**
 * Normalize a summary object from the model or the store.
 * @param raw - raw summary.
 * @param options - `previous` (previous summary for push-state carry-over),
 * `now` (reference moment), `model` (model id string).
 * @returns canonical summary, or null when `raw` is not an object.
 */
export function normalizeSummary(raw, options = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const now = options.now ?? new Date()
  const previous = Array.isArray(options.previous?.todos) ? options.previous.todos : []
  const rawTodos = Array.isArray(raw.todos) ? raw.todos : []
  const todos = []
  for (const entry of rawTodos) {
    const todo = normalizeTodo(entry, previous)
    if (todo !== null) todos.push(todo)
    if (todos.length >= 40) break
  }
  const decisions = []
  for (const entry of Array.isArray(raw.decisions) ? raw.decisions : []) {
    const text = typeof entry === 'string' ? capText(entry, 600) : capText(entry?.text, 600)
    if (text === '') continue
    decisions.push({
      text,
      owner: typeof entry === 'object' ? capText(entry?.owner, 60) : '',
      // 决策依据/影响（腾讯会议、通义听悟的「决策说明」），旧数据没有就留空
      rationale: typeof entry === 'object' ? capText(entry?.rationale ?? entry?.reason ?? entry?.impact, 500) : '',
    })
    if (decisions.length >= 20) break
  }
  const risks = []
  for (const entry of Array.isArray(raw.risks) ? raw.risks : []) {
    const text = typeof entry === 'string' ? capText(entry, 600) : capText(entry?.text, 600)
    if (text === '') continue
    const level = typeof entry === 'object' && RISK_LEVELS.includes(entry?.level) ? entry.level : 'medium'
    risks.push({
      text,
      level,
      // 应对建议（没有就留空）
      suggestion: typeof entry === 'object' ? capText(entry?.suggestion ?? entry?.mitigation, 500) : '',
    })
    if (risks.length >= 20) break
  }
  const sections = []
  for (const entry of Array.isArray(raw.sections) ? raw.sections : []) {
    if (entry === null || typeof entry !== 'object') continue
    const heading = capText(entry.heading, 120)
    const bullets = textList(entry.bullets, 20, 800)
    // 章节摘要（2-4 句），旧数据没有则为空
    const sectionSummary = capText(entry.summary ?? entry.digest, 800)
    if (heading === '' && bullets.length === 0 && sectionSummary === '') continue
    sections.push({
      heading: heading === '' ? '议题' : heading,
      summary: sectionSummary,
      bullets,
    })
    if (sections.length >= 30) break
  }
  const speakerSummaries = []
  for (const entry of Array.isArray(raw.speakerSummaries) ? raw.speakerSummaries : []) {
    if (entry === null || typeof entry !== 'object') continue
    const speaker = capText(entry.speaker ?? entry.name, 60)
    const summaryText = capText(entry.summary ?? entry.text, 1200)
    if (speaker === '' || summaryText === '') continue
    speakerSummaries.push({ speaker, summary: summaryText })
    if (speakerSummaries.length >= 20) break
  }
  return {
    oneLine: capText(raw.oneLine, 240),
    overview: formatOverviewParagraphs(capText(raw.overview, 6000)),
    keyPoints: textList(raw.keyPoints, 20, 800),
    // 关键词（产品/项目/系统/指标名），用于卡片上的标签
    keywords: textList(raw.keywords, 24, 40),
    decisions,
    risks,
    sections,
    // 发言人总结：只有转写里能区分说话人时才由模型输出
    speakerSummaries,
    // 待确认问题：和「风险」区分开，指需要会后确认的事实/数据/口径
    openQuestions: textList(raw.openQuestions, 20, 600),
    suggestedTitle: capText(raw.suggestedTitle, 60),
    attendees: normalizeAttendees(raw.attendees),
    todos,
    generatedAt: typeof raw.generatedAt === 'string' && raw.generatedAt !== '' ? raw.generatedAt : now.toISOString(),
    model: asText(options.model, asText(raw.model, '')),
  }
}

/** Auto-ingest configuration defaults, persisted in the meeting document. */
export const DEFAULT_AUTO_INGEST = {
  enabled: true,
  // 两个自动来源默认关闭：新安装不会被自动导入的会议打扰，需要时在设置里打开。
  tencent: false,
  tencentDir: '',
  dirs: [],
  dirsEnabled: false,
  ingested: {},
  failures: {},
  lastScanAt: null,
  lastError: null,
  importedCount: 0,
}

/** Normalize the persisted auto-ingest configuration and bookkeeping. */
export function normalizeAutoIngestConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const dirs = []
  for (const entry of Array.isArray(input.dirs) ? input.dirs : []) {
    const dir = capText(entry, 400)
    if (dir !== '' && !dirs.includes(dir)) dirs.push(dir)
    if (dirs.length >= 20) break
  }
  const ingested = {}
  if (input.ingested !== null && typeof input.ingested === 'object' && !Array.isArray(input.ingested)) {
    for (const [key, value] of Object.entries(input.ingested)) {
      if (typeof key !== 'string' || key === '' || key.length > 500) continue
      if (value === null || typeof value !== 'object') continue
      ingested[key] = {
        meetingId: asText(value.meetingId, ''),
        title: asText(value.title, ''),
        at: asText(value.at, ''),
        path: asText(value.path, ''),
      }
      if (Object.keys(ingested).length >= 500) break
    }
  }
  const failures = {}
  if (input.failures !== null && typeof input.failures === 'object' && !Array.isArray(input.failures)) {
    for (const [key, value] of Object.entries(input.failures)) {
      if (typeof key !== 'string' || key === '' || key.length > 500) continue
      failures[key] = {
        count: Number.isFinite(Number(value?.count)) ? Math.max(1, Math.min(20, Number(value.count))) : 1,
        message: capText(value?.message, 400),
        at: asText(value?.at, ''),
      }
      if (Object.keys(failures).length >= 200) break
    }
  }
  return {
    enabled: input.enabled !== false,
    tencent: input.tencent === true,
    tencentDir: capText(input.tencentDir, 400),
    dirs,
    dirsEnabled: input.dirsEnabled === true,
    ingested,
    failures,
    lastScanAt: typeof input.lastScanAt === 'string' && input.lastScanAt !== '' ? input.lastScanAt : null,
    lastError: capText(input.lastError, 500) || null,
    importedCount: Number.isFinite(Number(input.importedCount)) ? Math.max(0, Math.trunc(Number(input.importedCount))) : 0,
  }
}

/**
 * Normalize one meeting from tool arguments, HTTP bodies, or disk.
 * @param raw - partial meeting.
 * @param options - `now` (Date), `base` (existing record to patch onto).
 * @returns canonical meeting, or throws when the title is missing.
 */
export function normalizeMeeting(raw, options = {}) {
  const now = options.now ?? new Date()
  const base = options.base ?? {}
  const input = raw !== null && typeof raw === 'object' ? raw : {}

  const title = capText(input.title, 200) || capText(base.title, 200)
  if (title === '') throw new Error('meeting.title is required (non-empty string)')

  const date = input.date === undefined
    ? asText(base.date, localDay(now))
    : parseMeetingDate(input.date, now)
  const attendees = input.attendees === undefined
    ? normalizeAttendees(base.attendees)
    : normalizeAttendees(input.attendees)
  const sourceType = SOURCE_TYPES.includes(input.sourceType)
    ? input.sourceType
    : (SOURCE_TYPES.includes(base.sourceType) ? base.sourceType : 'text')
  const transcript = input.transcript === undefined
    ? asText(base.transcript)
    : String(input.transcript ?? '')
  const transcriptSeconds = Math.round((
    input.transcriptSeconds === undefined
      ? clampNumber(base.transcriptSeconds, 0, 0, 24 * 3600)
      : clampNumber(input.transcriptSeconds, 0, 0, 24 * 3600)
  ) * 10) / 10
  const notes = input.notes === undefined ? asText(base.notes) : capText(input.notes, 4000)
  const autoImported = input.autoImported === true || (input.autoImported === undefined && base.autoImported === true)
  const summaryInput = input.summary === undefined ? base.summary ?? null : input.summary
  const summary = summaryInput === null
    ? null
    : normalizeSummary(summaryInput, {
      now,
      previous: input.summary === undefined ? undefined : base.summary,
      model: asText(input.model, ''),
    })

  /** 录制产物（MP4/WAV）：只保留必要字段，避免把无关内容写进库。 */
  const rawMedia = Array.isArray(input.media) ? input.media : (Array.isArray(base.media) ? base.media : [])
  const media = rawMedia
    .map((entry) => {
      if (entry === null || typeof entry !== 'object') return null
      const path = capText(entry.path, 600)
      if (path === '') return null
      const item = {
        kind: entry.kind === 'video' ? 'video' : 'audio',
        name: capText(entry.name, 200),
        path,
        bytes: Math.max(0, Math.round(Number(entry.bytes) || 0)),
        seconds: Math.round(clampNumber(entry.seconds, 0, 0, 24 * 3600)),
        savedAt: capText(entry.savedAt, 40),
      }
      if (entry.converting === true) item.converting = true
      if (entry.converted === true) item.converted = true
      const convertError = capText(entry.convertError, 200)
      if (convertError !== '') item.convertError = convertError
      return item
    })
    .filter((entry) => entry !== null)
    .slice(0, 10)

  /** 分说话人转写片段：{ speaker: 'A'..'Z' | '', text, at }。 */
  const rawSegments = Array.isArray(input.transcriptSegments)
    ? input.transcriptSegments
    : (Array.isArray(base.transcriptSegments) ? base.transcriptSegments : [])
  const transcriptSegments = rawSegments
    .map((segment) => {
      if (segment === null || typeof segment !== 'object') return null
      const text = capText(segment.text, 2000)
      if (text === '') return null
      const speaker = /^[A-Z]$/.test(String(segment.speaker ?? '')) ? String(segment.speaker) : ''
      return { speaker, text, at: Math.max(0, Math.round(Number(segment.at) || 0)) }
    })
    .filter((segment) => segment !== null)
    .slice(0, 500)

  const speakerNames = normalizeSpeakerNames(
    input.speakerNames === undefined ? base.speakerNames : input.speakerNames,
    base.speakerNames,
  )
  const audioQuality = normalizeAudioQuality(input.audioQuality === undefined ? base.audioQuality : input.audioQuality)
  const correction = normalizeCorrection(input.correction === undefined ? base.correction : input.correction)

  return {
    id: asText(input.id, asText(base.id, newId())),
    title,
    date,
    attendees,
    sourceType,
    transcript,
    transcriptSeconds,
    transcriptSegments,
    speakerNames,
    audioQuality,
    correction,
    media,
    notes,
    autoImported,
    summary,
    createdAt: asText(input.createdAt, asText(base.createdAt, now.toISOString())),
    updatedAt: asText(input.updatedAt, now.toISOString()),
  }
}

/** 归一化说话人重命名映射：{ A: '张三' }，最多 10 个、每个名字 ≤20 字。 */
export function normalizeSpeakerNames(value, base = {}) {
  const source = value === undefined ? base : value
  const input = source !== null && typeof source === 'object' && !Array.isArray(source) ? source : {}
  const names = {}
  for (const [key, raw] of Object.entries(input)) {
    if (!/^[A-Z]$/.test(key)) continue
    const name = capText(raw, 20)
    if (name === '') continue
    names[key] = name
    if (Object.keys(names).length >= 10) break
  }
  return names
}

/** 归一化录音质量分析结果（来自宿主侧 audio-quality）。 */
export function normalizeAudioQuality(value) {
  if (value === null || typeof value !== 'object') return null
  const level = ['good', 'fair', 'poor'].includes(value.level) ? value.level : 'fair'
  const summary = capText(value.summary, 240)
  const suggestions = Array.isArray(value.suggestions)
    ? value.suggestions.map((item) => capText(item, 120)).filter((item) => item !== '').slice(0, 3)
    : []
  const metrics = value.metrics !== null && typeof value.metrics === 'object' ? value.metrics : {}
  const number = (key) => {
    const parsed = Number(metrics[key])
    return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : 0
  }
  return {
    level,
    summary,
    suggestions,
    metrics: {
      durationSeconds: number('durationSeconds'),
      rmsDbfs: number('rmsDbfs'),
      peakDbfs: number('peakDbfs'),
      snrDb: number('snrDb'),
      noiseDbfs: number('noiseDbfs'),
      clippingRatio: number('clippingRatio'),
      silenceRatio: number('silenceRatio'),
    },
    analyzedAt: capText(value.analyzedAt, 40),
  }
}

/** 归一化「纠错待审阅」：原文/修改稿/逐行变化。 */
export function normalizeCorrection(value) {
  if (value === null || typeof value !== 'object') return null
  const changes = []
  for (const entry of Array.isArray(value.changes) ? value.changes : []) {
    if (entry === null || typeof entry !== 'object') continue
    const before = capText(entry.before, 4000)
    const after = capText(entry.after, 4000)
    if (before === '' && after === '') continue
    const index = Number(entry.index)
    changes.push({
      ...(Number.isInteger(index) && index >= 0 ? { index } : {}),
      before,
      after,
    })
    if (changes.length >= 500) break
  }
  const original = capText(value.original, 200000)
  const corrected = capText(value.corrected, 200000)
  if (original === '' || corrected === '' || changes.length === 0) return null
  return {
    at: capText(value.at, 40),
    original,
    corrected,
    changes,
  }
}

/**
 * 为转写纠错挑几场「相关历史会议」的结论，帮助模型判断专有名词/同音词。
 * 相关度：参会人重合优先，其次最近更新；最多 3 场、总字数受限。
 */
export function buildCorrectionContext(meetings, current, maxChars = 1200) {
  const list = Array.isArray(meetings) ? meetings : []
  const target = current !== null && typeof current === 'object' ? current : {}
  const attendees = new Set(Array.isArray(target.attendees) ? target.attendees : [])
  const candidates = []
  for (const meeting of list) {
    if (meeting === null || typeof meeting !== 'object') continue
    if (meeting.id === target.id) continue
    if (meeting.summary === null || meeting.summary === undefined) continue
    const overlap = (Array.isArray(meeting.attendees) ? meeting.attendees : []).filter((name) => attendees.has(name)).length
    candidates.push({ meeting, overlap, stamp: String(meeting.updatedAt ?? meeting.date ?? '') })
  }
  candidates.sort((left, right) => right.overlap - left.overlap || right.stamp.localeCompare(left.stamp))
  const lines = []
  let total = 0
  for (const { meeting } of candidates.slice(0, 3)) {
    const summary = meeting.summary ?? {}
    const decisionText = (Array.isArray(summary.decisions) ? summary.decisions : [])
      .map((item) => (typeof item === 'string' ? item : String(item?.text ?? '')))
      .filter((item) => item !== '')
      .slice(0, 2)
      .join('；')
    const line = '《' + String(meeting.title ?? '') + '》（' + String(meeting.date ?? '') + '）：'
      + String(summary.oneLine ?? '')
      + (decisionText === '' ? '' : '；决策：' + decisionText)
    if (line.length < 10) continue
    if (total + line.length > maxChars) break
    lines.push(line)
    total += line.length
  }
  return lines.join('\n')
}

/** 归一化「生成纪要使用的模型」：`{ provider, model }` 或 null（跟随 DSH 默认）。 */
export function normalizeSummaryModel(value) {
  if (value === null || value === undefined || typeof value !== 'object') return null
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (provider === '' || model === '') return null
  return { provider: provider.slice(0, 120), model: model.slice(0, 200) }
}

/** Compact list projection used by the sidebar/list and `GET /state`. */
export function projectMeeting(meeting) {
  const summary = meeting.summary
  const todos = summary?.todos ?? []
  return {
    id: meeting.id,
    title: meeting.title,
    date: meeting.date,
    attendees: [...meeting.attendees],
    sourceType: meeting.sourceType,
    hasSummary: summary !== null,
    todoCount: todos.length,
    pendingTodoCount: todos.filter((todo) => todo.calendarTaskId === null).length,
    transcriptChars: meeting.transcript.length,
    transcriptSeconds: meeting.transcriptSeconds,
    autoImported: meeting.autoImported === true,
    updatedAt: meeting.updatedAt,
  }
}

/**
 * Extract one JSON object from model output. Accepts fenced code blocks and
 * surrounding prose; returns `null` when no parseable object is present.
 * @param text - raw model output.
 */
export function parseSummaryJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  let body = text.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(body)
  if (fence !== null) body = fence[1].trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  const slice = body.slice(start, end + 1)
  try {
    const parsed = JSON.parse(slice)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Count todos that still need pushing, for tool output. */
export function todoProgress(meeting) {
  const todos = meeting.summary?.todos ?? []
  const pushed = todos.filter((todo) => todo.calendarTaskId !== null).length
  return { total: todos.length, pushed, pending: todos.length - pushed }
}

/** One-line human label for a meeting. */
export function meetingLine(meeting) {
  const parts = [`[${meeting.id}] ${meeting.title}`, meeting.date]
  if (meeting.attendees.length > 0) parts.push(meeting.attendees.join('、'))
  parts.push(meeting.summary === null ? '未总结' : '已总结')
  const progress = todoProgress(meeting)
  if (progress.total > 0) parts.push(`待办 ${progress.pushed}/${progress.total} 已写入日历`)
  return parts.join(' · ')
}
