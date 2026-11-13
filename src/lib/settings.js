/**
 * 插件设置（模型与转写/纪要行为）。
 *
 * 存储位置：meeting-minutes.json 的 `settings` 字段（与会议数据同一个文件）。
 * 这里只做"归一化 + 校验 + 默认值"，读写交给 store。
 *
 * @module dsh-plugin-meeting-minutes/settings
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
  /** 转写结束后用 LLM 做一次语境纠错（错别字/人名/术语）。 */
  correctTranscript: true,
  /** 用声纹做真说话人分离（需要 Paraformer + pyannote + cam++ 模型就绪）。 */
  diarize: true,
}

function text(value, limit = 200) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
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
    correctTranscript: input.correctTranscript === undefined ? baseInput.correctTranscript !== false : input.correctTranscript !== false,
    // 真说话人分离固定开启：模型就绪就自动做，没装模型时自动跳过
    diarize: true,
  }
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
