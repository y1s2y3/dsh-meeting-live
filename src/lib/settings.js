/**
 * 插件设置（模型与转写/纪要行为）。
 *
 * 存储位置：meeting-minutes.json 的 `settings` 字段（与会议数据同一个文件）。
 * 这里只做"归一化 + 校验 + 默认值"，读写交给 store。
 *
 * @module dsh-meeting-live/settings
 */

/** 可选的语音转写引擎。 */
export const TRANSCRIBE_PROVIDERS = [
  'sensevoice-local',
  'paraformer-local',
  'cloud-iflytek',
  'cloud-tencent',
  'cloud-aliyun',
]

/** 云端引擎对应的展示名（也用于设置页分组）。 */
export const CLOUD_PROVIDERS = {
  'cloud-iflytek': '讯飞',
  'cloud-tencent': '腾讯云',
  'cloud-aliyun': '阿里云',
}

/** 默认设置。 */
export const DEFAULT_SETTINGS = {
  transcribe: {
    provider: 'paraformer-local',
    cloud: {
      iflytek: { appId: '', apiKey: '', apiSecret: '' },
      tencent: { secretId: '', secretKey: '', region: 'ap-shanghai', engine: '16k_zh' },
      aliyun: { appKey: '', accessKeyId: '', accessKeySecret: '', region: 'cn-shanghai' },
    },
  },
  summary: {
    mode: 'dsh',
    custom: { baseUrl: '', apiKey: '', model: '', temperature: 0.3, maxTokens: 8192 },
  },
  /** 术语表：每行一个词，用于转写后的 LLM 纠错提示。 */
  terms: '',
  /**
   * 纠错经验：每行一条领域知识 / 易错点（如「安质部（不是安置部）」），
   * 转写纠错时作为领域参考注入提示词；只用于判断，不要求逐字照抄。
   */
  correctionNotes: '',
  /**
   * 从文件夹里解析出来的术语（按重要性排序，最多 50 个）。
   * 结构：{ dir, at, items: [{ id, text, category, priority, evidence, count }], stats }
   */
  termExtract: {
    dirs: [],
    at: '',
    items: [],
    stats: { folders: 0, files: 0, supported: 0, skipped: 0, chars: 0, truncated: false },
  },
  /** 转写结束后用 LLM 做一次语境纠错（错别字/人名/术语）。 */
  correctTranscript: true,
  /**
   * 转写整理强度：
   * - light（默认）：补标点、断句、改错字，不改写句式；
   * - polish：进一步把口语整理成通顺书面句（去口头禅、合并重复），但不增删信息。
   */
  transcriptStyle: 'light',
  /** 纪要风格：general/review/weekly/client/retro（影响总结 prompt 的侧重）。 */
  summaryTemplate: 'general',
  /** 纠错结果先审阅（逐句对比、勾选接受）还是直接替换转写。 */
  reviewCorrections: true,
  /** 音频预处理：转码/重转写前做音量归一化 + 高通滤波（需要 ffmpeg）。 */
  preprocessAudio: true,
  /** 用声纹做真说话人分离（需要 Paraformer + pyannote + cam++ 模型就绪）。 */
  diarize: true,
  /**
   * 自动人数优选：自动聚类超过 4 人（明显过分割）时，补跑 4/3 人档，
   * 用声纹质量评分选最稳的一档；耗时约为单档的 2~3 倍。
   */
  diarizeAutoSpeakers: true,
  /** 相近音色二次合并（用每个说话人的声纹质心，把同一个人被拆开的簇合回去）。 */
  diarizeMerge: true,
  /** 二次合并阈值：质心余弦相似度 ≥ 阈值才合并；越大越保守（默认 0.68）。 */
  diarizeMergeThreshold: 0.68,
}

function text(value, limit = 200) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

/** 合法的术语分类（与提取 prompt 约定一致）。 */
const TERM_CATEGORIES = ['术语', '产品/系统', '项目', '机构', '人名', '其他']

/** 纪要风格（与 summarize.TEMPLATE_INSTRUCTIONS 对应）。 */
const SUMMARY_TEMPLATES = ['general', 'review', 'weekly', 'client', 'retro']

/** 生成术语条目的稳定 id（只用于前端删除/渲染，不参与业务）。 */
function newTermId() {
  return 'tm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/**
 * 归一化「从文件夹提取的术语」列表：去重、按 priority 排序、最多 50 个，
 * 并把 priority 重排成连续的 1..N（界面上就是 1、2、3…名）。
 */
export function normalizeTermItems(raw) {
  const seen = new Set()
  const items = []
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (entry === null || typeof entry !== 'object') continue
    const value = singleLine(entry.text ?? entry.term, 40)
    if (value === '' || value.length < 2) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const priority = Number(entry.priority)
    const count = Number(entry.count)
    items.push({
      id: typeof entry.id === 'string' && /^[A-Za-z0-9_-]{3,40}$/.test(entry.id) ? entry.id : newTermId(),
      text: value,
      category: TERM_CATEGORIES.includes(entry.category) ? entry.category : '术语',
      priority: Number.isFinite(priority) ? Math.max(1, Math.min(999, Math.round(priority))) : items.length + 1,
      evidence: singleLine(entry.evidence ?? entry.note, 80),
      count: Number.isFinite(count) ? Math.max(1, Math.min(9999, Math.round(count))) : 1,
    })
    if (items.length >= 50) break
  }
  items.sort((a, b) => a.priority - b.priority)
  return items.map((item, index) => ({ ...item, priority: index + 1 }))
}

/** 归一化「文件夹术语提取」整体结果（目录列表、时间、术语、统计）。 */
export function normalizeTermExtract(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const dirs = []
  const seen = new Set()
  const candidates = Array.isArray(input.dirs) ? input.dirs : (typeof input.dir === 'string' ? [input.dir] : [])
  for (const item of candidates) {
    const value = singleLine(item, 500)
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    dirs.push(value)
    if (dirs.length >= 12) break
  }
  const at = typeof input.at === 'string' && input.at !== '' ? input.at.slice(0, 40) : ''
  const stats = input.stats !== null && typeof input.stats === 'object' ? input.stats : {}
  const number = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.min(1000000, Math.round(Number(value)))) : 0)
  return {
    dirs,
    at,
    // 即使文件夹列表被删空，已保存的术语也保留：删文件夹不等于删术语
    items: normalizeTermItems(input.items),
    stats: {
      folders: number(stats.folders),
      files: number(stats.files),
      supported: number(stats.supported),
      skipped: number(stats.skipped),
      chars: number(stats.chars),
      truncated: stats.truncated === true,
    },
  }
}

function singleLine(value, limit = 200) {
  return text(value, limit).replace(/\s+/g, ' ')
}

function normalizeCloud(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const iflytek = input.iflytek !== null && typeof input.iflytek === 'object' ? input.iflytek : {}
  const tencent = input.tencent !== null && typeof input.tencent === 'object' ? input.tencent : {}
  const aliyun = input.aliyun !== null && typeof input.aliyun === 'object' ? input.aliyun : {}
  return {
    iflytek: {
      appId: text(iflytek.appId, 60),
      apiKey: text(iflytek.apiKey, 120),
      apiSecret: text(iflytek.apiSecret, 200),
    },
    tencent: {
      secretId: text(tencent.secretId, 200),
      secretKey: text(tencent.secretKey, 200),
      region: singleLine(tencent.region, 40) || 'ap-shanghai',
      engine: singleLine(tencent.engine, 40) || '16k_zh',
    },
    aliyun: {
      appKey: text(aliyun.appKey, 120),
      accessKeyId: text(aliyun.accessKeyId, 200),
      accessKeySecret: text(aliyun.accessKeySecret, 200),
      region: singleLine(aliyun.region, 40) || 'cn-shanghai',
    },
  }
}

/**
 * 归一化设置：任何非法值都退回默认值，绝不让坏配置挡住转写。
 * @param raw - 磁盘上读到的设置（可能缺字段）。
 * @param base - 合并基准（默认取 DEFAULT_SETTINGS）。
 */
export function normalizeSettings(raw, base = DEFAULT_SETTINGS) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const baseInput = base !== null && typeof base === 'object' ? base : DEFAULT_SETTINGS
  const transcribe = input.transcribe !== null && typeof input.transcribe === 'object' ? input.transcribe : {}
  const baseTranscribe = baseInput.transcribe ?? DEFAULT_SETTINGS.transcribe
  // SenseVoice 已从设置项移除：历史配置自动迁移到 Paraformer
  const rawProvider = transcribe.provider === 'sensevoice-local' ? 'paraformer-local' : transcribe.provider
  const provider = TRANSCRIBE_PROVIDERS.includes(rawProvider)
    ? rawProvider
    : (TRANSCRIBE_PROVIDERS.includes(baseTranscribe.provider) ? baseTranscribe.provider : 'paraformer-local')
  const summary = input.summary !== null && typeof input.summary === 'object' ? input.summary : {}
  const baseSummary = baseInput.summary ?? DEFAULT_SETTINGS.summary
  const summaryRaw = summary.custom !== null && typeof summary.custom === 'object' ? summary.custom : {}
  const baseSummaryCustom = baseSummary.custom ?? DEFAULT_SETTINGS.summary.custom
  const termsInput = input.terms === undefined ? baseInput.terms : input.terms
  return {
    transcribe: {
      provider,
      cloud: normalizeCloud(transcribe.cloud === undefined ? baseTranscribe.cloud : transcribe.cloud),
    },
    summary: {
      mode: summary.mode === 'custom' ? 'custom' : (summary.mode === 'dsh' ? 'dsh' : (baseSummary.mode === 'custom' ? 'custom' : 'dsh')),
      custom: {
        baseUrl: singleLine(summaryRaw.baseUrl === undefined ? baseSummaryCustom.baseUrl : summaryRaw.baseUrl, 300),
        apiKey: text(summaryRaw.apiKey === undefined ? baseSummaryCustom.apiKey : summaryRaw.apiKey, 400),
        model: singleLine(summaryRaw.model === undefined ? baseSummaryCustom.model : summaryRaw.model, 120),
        temperature: (() => {
          const value = Number(summaryRaw.temperature === undefined ? baseSummaryCustom.temperature : summaryRaw.temperature)
          if (!Number.isFinite(value)) return 0.3
          return Math.max(0, Math.min(1.5, Math.round(value * 100) / 100))
        })(),
        maxTokens: (() => {
          const value = Number(summaryRaw.maxTokens === undefined ? baseSummaryCustom.maxTokens : summaryRaw.maxTokens)
          if (!Number.isFinite(value)) return 8192
          return Math.max(512, Math.min(65536, Math.round(value)))
        })(),
      },
    },
    terms: typeof termsInput === 'string' ? termsInput.slice(0, 4000) : '',
    correctionNotes: normalizeCorrectionNotes(input.correctionNotes === undefined ? baseInput.correctionNotes : input.correctionNotes),
    termExtract: normalizeTermExtract(input.termExtract === undefined ? baseInput.termExtract : input.termExtract),
    correctTranscript: input.correctTranscript === undefined ? baseInput.correctTranscript !== false : input.correctTranscript !== false,
    transcriptStyle: input.transcriptStyle === 'polish' || input.transcriptStyle === 'light'
      ? input.transcriptStyle
      : (baseInput.transcriptStyle === 'polish' ? 'polish' : 'light'),
    reviewCorrections: input.reviewCorrections === undefined ? baseInput.reviewCorrections !== false : input.reviewCorrections !== false,
    summaryTemplate: SUMMARY_TEMPLATES.includes(String(input.summaryTemplate ?? baseInput.summaryTemplate))
      ? String(input.summaryTemplate ?? baseInput.summaryTemplate)
      : 'general',
    preprocessAudio: input.preprocessAudio === undefined ? baseInput.preprocessAudio !== false : input.preprocessAudio !== false,
    // 真说话人分离固定开启：模型就绪就自动做，没装模型时自动跳过
    diarize: true,
    // 自动人数优选：默认开启，可在设置页关掉（关掉只跑自动聚类一次，省时间）
    diarizeAutoSpeakers: input.diarizeAutoSpeakers === undefined
      ? baseInput.diarizeAutoSpeakers !== false
      : input.diarizeAutoSpeakers !== false,
    // 相近音色二次合并：把「同一个人被拆成多个簇」按质心相似度合回去；默认开启
    diarizeMerge: input.diarizeMerge === undefined
      ? baseInput.diarizeMerge !== false
      : input.diarizeMerge !== false,
    // 合并阈值：0.55~0.85，默认 0.68（越大越保守）
    diarizeMergeThreshold: normalizeMergeThreshold(
      input.diarizeMergeThreshold === undefined ? baseInput.diarizeMergeThreshold : input.diarizeMergeThreshold,
    ),
  }
}

/** 二次合并阈值归一化：0.55~0.85，非法值回落默认 0.68。 */
function normalizeMergeThreshold(value) {
  const threshold = Number(value)
  if (!Number.isFinite(threshold)) return 0.68
  return Math.min(0.85, Math.max(0.55, Math.round(threshold * 100) / 100))
}

/** 纠错经验在设置里最多保存多少字。 */
export const CORRECTION_NOTES_MAX_CHARS = 4000
/** 每次纠错实际注入提示词的经验字数上限（控制 token 与干扰）。 */
export const CORRECTION_NOTES_IN_PROMPT_CHARS = 1200
/** 最多保存多少条纠错经验。 */
export const CORRECTION_NOTES_MAX_LINES = 60
/** 单条纠错经验最多多少字。 */
export const CORRECTION_NOTES_LINE_MAX_CHARS = 160

/**
 * 把「纠错经验」文本拆成条目：去空行、去 # 注释、去重、单条限长。
 * @param value - 每行一条的文本。
 * @returns 条目数组（保持用户书写顺序）。
 */
export function parseCorrectionNotes(value) {
  if (typeof value !== 'string' || value.trim() === '') return []
  const seen = new Set()
  const items = []
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.length > CORRECTION_NOTES_LINE_MAX_CHARS) continue
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    items.push(line)
    if (items.length >= CORRECTION_NOTES_MAX_LINES) break
  }
  return items
}

/** 归一化纠错经验：按条目拼回多行文本，总字数受限，保留顺序。 */
export function normalizeCorrectionNotes(value) {
  const items = parseCorrectionNotes(value)
  const kept = []
  let total = 0
  for (const line of items) {
    if (total + line.length > CORRECTION_NOTES_MAX_CHARS) break
    kept.push(line)
    total += line.length + 1
  }
  return kept.join('\n')
}

/**
 * 纠错时实际注入提示词的经验文本：按顺序取，控制在
 * CORRECTION_NOTES_IN_PROMPT_CHARS 以内，避免提示词过长。
 */
export function effectiveCorrectionNotes(settings) {
  const items = parseCorrectionNotes(settings?.correctionNotes)
  const kept = []
  let total = 0
  for (const line of items) {
    if (total + line.length > CORRECTION_NOTES_IN_PROMPT_CHARS) break
    kept.push(line)
    total += line.length + 1
  }
  return kept.join('\n')
}

/** 把术语表拆成数组（去空行、去重、最多 200 条）。 */
export function parseTerms(value) {
  if (typeof value !== 'string' || value.trim() === '') return []
  const seen = new Set()
  for (const line of value.split(/\r?\n/)) {
    const item = line.trim()
    if (item === '' || item.length > 60) continue
    seen.add(item)
  }
  return [...seen].slice(0, 200)
}

/**
 * 纠正转写时实际使用的术语列表：先放「文件夹提取」的术语（已按重要性排序），
 * 再补上手动术语表；去重后最多 120 条，避免 prompt 过长。
 */
export function effectiveTerms(settings) {
  const merged = []
  const seen = new Set()
  const push = (value) => {
    const item = singleLine(value, 60)
    if (item === '' || seen.has(item.toLowerCase())) return
    seen.add(item.toLowerCase())
    merged.push(item)
  }
  const items = Array.isArray(settings?.termExtract?.items) ? settings.termExtract.items : []
  for (const entry of items) push(entry?.text)
  for (const item of parseTerms(settings?.terms)) push(item)
  return merged.slice(0, 120)
}

/** 云端引擎的必填项校验；返回中文错误或 null。 */
export function validateCloudSettings(provider, cloud) {
  const input = cloud !== null && typeof cloud === 'object' ? cloud : {}
  const nonEmpty = (value) => typeof value === 'string' && value.trim() !== ''
  if (provider === 'cloud-iflytek') {
    const item = input.iflytek ?? {}
    if (!nonEmpty(item.appId) || !nonEmpty(item.apiKey) || !nonEmpty(item.apiSecret)) return '讯飞语音识别需要填写 AppID、APIKey、APISecret'
    return null
  }
  if (provider === 'cloud-tencent') {
    const item = input.tencent ?? {}
    if (!nonEmpty(item.secretId) || !nonEmpty(item.secretKey)) return '腾讯云语音识别需要填写 SecretId、SecretKey'
    return null
  }
  if (provider === 'cloud-aliyun') {
    const item = input.aliyun ?? {}
    if (!nonEmpty(item.appKey) || !nonEmpty(item.accessKeyId) || !nonEmpty(item.accessKeySecret)) return '阿里云语音识别需要填写 AppKey、AccessKeyId、AccessKeySecret'
    return null
  }
  return null
}

/** 会议总结模型的自定义配置校验；返回中文错误或 null。 */
export function validateSummaryCustom(custom) {
  const input = custom !== null && typeof custom === 'object' ? custom : {}
  if (input.baseUrl === '' || input.model === '') return '手动配置总结模型需要填写接口地址与模型名（API Key 视服务是否必需）'
  try {
    const url = new URL(input.baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '接口地址必须是 http(s) 开头'
  } catch {
    return '接口地址不是合法的 URL'
  }
  return null
}
