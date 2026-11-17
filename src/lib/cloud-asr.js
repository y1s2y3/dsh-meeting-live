/**
 * cloud-asr.mjs —— 云端语音识别客户端（自包含单文件模块，ESM，Node 24 / Electron 主进程）
 *
 * 支持三家云服务商：
 *   ① 科大讯飞   iat-api.xfyun.cn           WebSocket 实时听写接口（v2/iat），HMAC-SHA256 鉴权
 *   ② 腾讯云     asr.tencentcloudapi.com    TC3-HMAC-SHA256 签名的一句话识别（SentenceRecognition）
 *   ③ 阿里云     nls-meta / nls-gateway     RPC 签名取 Token（CreateToken），再走一句话识别 HTTP 接口
 *
 * 设计约定：
 *   · 只依赖 Node 内置模块（node:buffer、node:crypto）与 Node 24 的全局 fetch / WebSocket，不引入任何三方依赖；
 *   · 顶层无副作用：import 本模块时不联网、不抛错、不读环境变量、不写日志；
 *   · 对外函数不向上抛异常：validateCloudConfig / transcribeCloud 一律返回结果对象，
 *     buildIflytekAuthUrl / buildTencentHeaders / buildAliyunTokenSignature 在参数缺失时抛「中文」Error（便于单测定位），
 *     但异常消息里不含 Secret / Key 明文；
 *   · 任何错误信息都不会回显带鉴权参数的 URL，也不会包含 secret / key 明文（统一过 sanitizeMessage 清洗）。
 */

import { Buffer } from 'node:buffer';
import { createHash, createHmac, randomUUID } from 'node:crypto';

/* ================================ 常量 ================================ */

/** 单次网络请求的超时时间（毫秒）：30 秒 */
const REQUEST_TIMEOUT_MS = 30_000;

/* 讯飞 */
const IFLYTEK_HOST = 'iat-api.xfyun.cn';
const IFLYTEK_PATH = '/v2/iat';
/** 讯飞要求的音频帧大小：1280 字节（16k / 16bit / 单声道 ≈ 40ms） */
const IFLYTEK_FRAME_BYTES = 1280
/** 讯飞 iat 帧间隔：服务端按实时流消费，灌太快会丢帧；10ms/帧≈4 倍速。 */
const IFLYTEK_FRAME_INTERVAL_MS = 10;

/* 腾讯云 */
const TENCENT_HOST = 'asr.tencentcloudapi.com';
const TENCENT_SERVICE = 'asr';
const TENCENT_ACTION = 'SentenceRecognition';
const TENCENT_VERSION = '2019-06-14';
const TENCENT_CONTENT_TYPE = 'application/json; charset=utf-8';
/** TC3 参与签名的请求头（必须与实际发送的请求头完全一致） */
const TENCENT_SIGNED_HEADERS = 'content-type;host;x-tc-action';

/* 阿里云 */
const ALIYUN_TOKEN_ACTION = 'CreateToken';
const ALIYUN_TOKEN_VERSION = '2019-02-28';
const ALIYUN_DEFAULT_REGION = 'cn-shanghai';
/** 阿里云热词表（POP API）：一句话识别用 vocabulary_id 引用。 */
const ALIYUN_VOCAB_CREATE_ACTION = 'CreateAsrVocab';
const ALIYUN_VOCAB_UPDATE_ACTION = 'UpdateAsrVocab';
const ALIYUN_VOCAB_VERSION = '2018-11-20';
const ALIYUN_VOCAB_NAME = 'dsh-meeting-live-terms';

/** 各家是否支持「请求级热词」：讯飞的热词要在控制台「个性化热词」上传，无法随请求带。 */
export const PROVIDER_HOTWORD_SUPPORT = {
  iflytek: false,
  tencent: true,
  aliyun: true,
};

/** 音频无效时的固定提示（对外口径统一） */
const INVALID_AUDIO_ERROR = '音频数据无效（需要 16k 单声道 WAV）';

/** 三家服务商的展示名与必填字段（错误信息里只出现字段中文名，不出现字段值） */
const PROVIDER_META = {
  iflytek: {
    label: '科大讯飞',
    fields: [
      { key: 'appId', name: '应用 ID（appId）' },
      { key: 'apiKey', name: 'API Key（apiKey）' },
      { key: 'apiSecret', name: 'API Secret（apiSecret）' },
    ],
  },
  tencent: {
    label: '腾讯云',
    fields: [
      { key: 'secretId', name: 'SecretId' },
      { key: 'secretKey', name: 'SecretKey' },
    ],
  },
  aliyun: {
    label: '阿里云',
    fields: [
      { key: 'appKey', name: '项目 AppKey（appKey）' },
      { key: 'accessKeyId', name: 'AccessKey ID' },
      { key: 'accessKeySecret', name: 'AccessKey Secret' },
    ],
  },
};

/* ============================ 内部工具 ============================ */

/** 模块内部的可读错误：消息本身已保证是中文、且不含凭据 */
class CloudAsrError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CloudAsrError';
    this.isCloudAsrError = true;
  }
}

/** 判断凭据字段是否为空（undefined / null / 纯空白字符串都算缺失） */
function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * 清洗错误文本：抹掉 URL（可能带 appkey / 鉴权串）与长 base64 串，控制在 200 字符内。
 * 目的：任何链路抛出的原始错误都不得把凭据带进对外错误信息。
 */
function sanitizeMessage(message) {
  if (message === undefined || message === null || message === '') return '未知错误';
  let text = String(message);
  // 隐藏任意协议头的 URL（wss://、https:// 等）
  text = text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '<已隐藏地址>');
  // 隐藏疑似 base64 / 十六进制鉴权串
  text = text.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '<已隐藏>');
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** 把任意异常转换成对外的中文错误（CloudAsrError 直接用，其余先清洗再包一层） */
function toReadableError(error) {
  if (error instanceof CloudAsrError) return error.message;
  const message = error && typeof error.message === 'string' ? error.message : String(error);
  return `云端识别失败：${sanitizeMessage(message)}`;
}

/**
 * 归一化时间戳：支持秒级 / 毫秒级 Unix 时间戳、Date、ISO 字符串。
 * @returns {number} 秒级 Unix 时间戳
 */
function resolveTimestampSeconds(value) {
  if (value === undefined || value === null || value === '') return Math.floor(Date.now() / 1000);
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const num = Number(text);
    return num > 1e12 ? Math.floor(num / 1000) : Math.floor(num);
  }
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  throw new CloudAsrError('时间戳无效：需要秒级/毫秒级 Unix 时间戳、Date 或 ISO 时间字符串');
}

/**
 * 创建统一超时 + 外部取消的 AbortController 包装。
 * @param {AbortSignal|undefined} signal 调用方传入的信号
 * @param {number} timeoutMs 超时毫秒数
 */
function createRequestController(signal, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // 定时器不应阻止进程退出（Electron 主进程 / 单测场景都友好）
  if (typeof timer.unref === 'function') timer.unref();

  const onExternalAbort = () => controller.abort();
  const hasExternalSignal = signal && typeof signal.addEventListener === 'function';
  if (hasExternalSignal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      if (hasExternalSignal) signal.removeEventListener('abort', onExternalAbort);
    },
  };
}

/** 把 fetch / 网络层异常翻译成中文错误（区分超时、主动取消、其它网络失败） */
function normalizeTransportError(error, ctx, label) {
  if (error instanceof CloudAsrError) return error;
  if (ctx.didTimeout()) {
    return new CloudAsrError(`${label}识别超时（超过 ${REQUEST_TIMEOUT_MS / 1000} 秒未返回）`);
  }
  if (ctx.signal.aborted) return new CloudAsrError('请求已取消');
  const cause = (error && error.cause && (error.cause.code || error.cause.message)) || (error && error.code) || (error && error.message);
  return new CloudAsrError(`${label}网络请求失败：${sanitizeMessage(cause)}`);
}

/** 发起请求并解析 JSON，同时把 HTTP 状态码与服务端错误信息写进中文错误 */
async function requestJson(url, options, label) {
  const response = await fetch(url, options);
  const status = response.status;
  const statusText = sanitizeMessage(response.statusText || '');
  const raw = await response.text();
  if (!response.ok) {
    let detail = '';
    try {
      const parsed = JSON.parse(raw);
      const message = parsed?.message ?? parsed?.Message ?? parsed?.errmsg ?? parsed?.errMsg ?? '';
      const code = parsed?.status ?? parsed?.Code ?? parsed?.code ?? '';
      if (message !== '' || code !== '') detail = `：${code !== '' ? `${code} ` : ''}${sanitizeMessage(message)}`.trim();
    } catch {
      if (raw.trim() !== '') detail = `：${sanitizeMessage(raw.trim()).slice(0, 200)}`;
    }
    throw new CloudAsrError(`${label}接口返回 HTTP ${status}${statusText && statusText !== '未知错误' ? `（${statusText}）` : ''}${detail}`);
  }
  if (!raw) throw new CloudAsrError(`${label}接口返回空响应（HTTP ${status}）`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new CloudAsrError(`${label}接口返回内容不是合法 JSON（HTTP ${status}）`);
  }
}

/* ============================ WAV 解析 ============================ */

/** 把入参收敛成 Buffer（接受 Buffer / Uint8Array，其它类型返回 null） */
function toAudioBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/**
 * 解析 WAV 头，定位 PCM 数据区（不假设一定是 44 字节，兼容带 LIST/fact 等附加块的 WAV）。
 * @returns {{ buffer: Buffer, dataOffset: number, dataLength: number } | null} 无效音频返回 null
 */
function parseWavHeader(value) {
  const buffer = toAudioBuffer(value);
  if (!buffer || buffer.length < 44) return null;
  if (buffer.toString('latin1', 0, 4) !== 'RIFF') return null;
  if (buffer.toString('latin1', 8, 12) !== 'WAVE') return null;

  let offset = 12;
  let dataOffset = -1;
  let dataLength = 0;

  // 逐块扫描，找到 data 块
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('latin1', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const bodyOffset = offset + 8;
    if (chunkId === 'data') {
      dataOffset = bodyOffset;
      dataLength = Math.max(0, Math.min(chunkSize, buffer.length - bodyOffset));
      break;
    }
    // 块大小为奇数时按规范补 1 字节对齐
    offset = bodyOffset + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0) {
    // 兜底：没有 data 块时按标准 44 字节头处理
    if (buffer.length <= 44) return null;
    return { buffer, dataOffset: 44, dataLength: buffer.length - 44 };
  }
  if (dataLength <= 0) return null;
  return { buffer, dataOffset, dataLength };
}

/* ========================= ① 配置校验 ========================= */

/**
 * 校验某家云服务商的配置是否齐全。
 * @param {'iflytek'|'tencent'|'aliyun'} provider 服务商标识
 * @param {object} config 该服务商的配置对象
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateCloudConfig(provider, config) {
  const meta = PROVIDER_META[provider];
  if (!meta) {
    const shown = isBlank(provider) ? '（空）' : String(provider);
    return {
      ok: false,
      error: `不支持的云服务商：${shown}；仅支持 iflytek（科大讯飞）、tencent（腾讯云）、aliyun（阿里云）`,
    };
  }
  if (!config || typeof config !== 'object') {
    const names = meta.fields.map((item) => item.name).join('、');
    return { ok: false, error: `${meta.label}配置缺失：请传入 ${names}` };
  }
  const missing = meta.fields.filter((item) => isBlank(config[item.key]));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `${meta.label}配置不完整：缺少 ${missing.map((item) => item.name).join('、')}`,
    };
  }
  return { ok: true };
}

/* ===================== ② 讯飞鉴权 URL（纯函数） ===================== */

/**
 * 构造讯飞实时听写（v2/iat）的 wss 鉴权地址。
 *
 * 讯飞官方签名算法（三个串依次生成）：
 *   ① signatureOrigin = "host: <host>\ndate: <RFC1123 日期>\nGET <path> HTTP/1.1"
 *   ② signature       = base64(HMAC-SHA256(apiSecret, signatureOrigin))
 *   ③ authorizationOrigin = 'api_key="<apiKey>", algorithm="hmac-sha256",
 *                            headers="host date request-line", signature="<signature>"'
 *   → authorization = base64(authorizationOrigin)，作为查询参数拼进 URL。
 *
 * @param {{ host?: string, path?: string, apiKey: string, apiSecret: string, date?: string|Date }} params
 * @returns {string} 可直接 new WebSocket(...) 的 wss 地址
 */
export function buildIflytekAuthUrl({ host = IFLYTEK_HOST, path = IFLYTEK_PATH, apiKey, apiSecret, date } = {}) {
  if (isBlank(apiKey)) throw new CloudAsrError('讯飞鉴权参数不完整：缺少 API Key（apiKey）');
  if (isBlank(apiSecret)) throw new CloudAsrError('讯飞鉴权参数不完整：缺少 API Secret（apiSecret）');

  // 日期必须是 RFC1123 格式（GMT），未传入时取当前 UTC 时间
  let dateText;
  if (isBlank(date)) dateText = new Date().toUTCString();
  else if (date instanceof Date) dateText = date.toUTCString();
  else dateText = String(date);

  const signatureOrigin = `host: ${host}\ndate: ${dateText}\nGET ${path} HTTP/1.1`;
  const signature = createHmac('sha256', apiSecret).update(signatureOrigin, 'utf8').digest('base64');
  const authorizationOrigin =
    `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin, 'utf8').toString('base64');

  return (
    `wss://${host}${path}` +
    `?authorization=${encodeURIComponent(authorization)}` +
    `&date=${encodeURIComponent(dateText)}` +
    `&host=${encodeURIComponent(host)}`
  );
}

/* ================== ③ 腾讯云 TC3-HMAC-SHA256 头 ================== */

/**
 * 生成腾讯云 TC3-HMAC-SHA256 签名请求头。
 *
 * 算法（官方文档 api-signature-v3）：
 *   ① 规范请求串 = HTTP方法\nURI\n查询串\n规范请求头\n参与签名的头列表\n哈希后的请求体
 *   ② 待签名串   = 算法\n时间戳\n凭证范围\n哈希后的规范请求串
 *   ③ 逐级 HMAC：secretDate = HMAC("TC3"+secretKey, 日期)
 *                 secretService = HMAC(secretDate, 服务名 asr)
 *                 secretSigning = HMAC(secretService, "tc3_request")
 *                 signature = Hex(HMAC(secretSigning, 待签名串))
 *
 * @param {{ secretId: string, secretKey: string, region?: string, timestamp?: number|string|Date,
 *           action?: string, payload?: object|string }} params
 * @returns {{ authorization: string, host: string, contentType: string, action: string,
 *             region: string, timestamp: string, signedHeaders: string }} 可直接展开为 fetch 请求头
 */
export function buildTencentHeaders({
  secretId,
  secretKey,
  region = 'ap-shanghai',
  timestamp,
  action = TENCENT_ACTION,
  payload,
} = {}) {
  if (isBlank(secretId)) throw new CloudAsrError('腾讯云鉴权参数不完整：缺少 SecretId');
  if (isBlank(secretKey)) throw new CloudAsrError('腾讯云鉴权参数不完整：缺少 SecretKey');

  const seconds = resolveTimestampSeconds(timestamp);
  // 日期取该时间戳对应的 UTC 日期（YYYY-MM-DD）
  const date = new Date(seconds * 1000).toISOString().slice(0, 10);
  // 签名用的请求体必须与真正发送的字节完全一致
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload === undefined ? {} : payload);
  const hashedPayload = createHash('sha256').update(body, 'utf8').digest('hex');
  const actionValue = String(action);
  const resolvedRegion = isBlank(region) ? 'ap-shanghai' : String(region);

  const canonicalHeaders = [
    `content-type:${TENCENT_CONTENT_TYPE}`,
    `host:${TENCENT_HOST}`,
    // 官方要求：x-tc-action 参与签名时取小写值
    `x-tc-action:${actionValue.toLowerCase()}`,
  ].join('\n');

  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    '',
    TENCENT_SIGNED_HEADERS,
    hashedPayload,
  ].join('\n');

  const credentialScope = `${date}/${TENCENT_SERVICE}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(seconds),
    credentialScope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');

  const secretDate = createHmac('sha256', `TC3${secretKey}`).update(date, 'utf8').digest();
  const secretService = createHmac('sha256', secretDate).update(TENCENT_SERVICE, 'utf8').digest();
  const secretSigning = createHmac('sha256', secretService).update('tc3_request', 'utf8').digest();
  const signature = createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${TENCENT_SIGNED_HEADERS}, Signature=${signature}`,
    host: TENCENT_HOST,
    contentType: TENCENT_CONTENT_TYPE,
    action: actionValue,
    region: resolvedRegion,
    timestamp: String(seconds),
    signedHeaders: TENCENT_SIGNED_HEADERS,
  };
}

/* ==================== ④ 阿里云 RPC 签名（CreateToken） ==================== */

/**
 * 阿里云 RPC 风格的百分号编码（RFC3986）：
 * 空格 → %20、* → %2A、! ' ( ) → 转义，~ 保持不编码。
 */
function aliyunPercentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/gi, '~');
}

/**
 * 按种子生成稳定的 SignatureNonce（UUID v4 形态）。
 * 传入固定的 timestamp 时必须得到相同的 nonce，才能保证纯函数可单测。
 */
function buildDeterministicNonce(seed) {
  const hex = createHash('sha256').update(String(seed), 'utf8').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 时间戳转阿里云要求的 ISO8601 UTC 形式：YYYY-MM-DDTHH:mm:ssZ（秒级，无毫秒） */
function toAliyunTimestampText(value) {
  const seconds = resolveTimestampSeconds(value);
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 内部：构造一个完整的阿里云 RPC 请求（参数、待签名串、签名、表单请求体）。
 * 签名规则：StringToSign = "POST&%2F&" + percentEncode(规范化后的查询串)，
 *          Signature = base64(HMAC-SHA1(AccessKeySecret + "&", StringToSign))。
 */
function buildAliyunRpcRequest({ action, version, regionId, accessKeyId, accessKeySecret, timestamp, nonce, extraParams }) {
  const params = {
    AccessKeyId: accessKeyId,
    Action: action,
    Format: 'JSON',
    RegionId: regionId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: nonce,
    SignatureVersion: '1.0',
    Timestamp: toAliyunTimestampText(timestamp),
    Version: version,
    ...(extraParams || {}),
  };

  // 参数名按字典序排序后逐项编码（签名用的规范化查询串）
  const canonicalizedQuery = Object.keys(params)
    .sort()
    .map((key) => `${aliyunPercentEncode(key)}=${aliyunPercentEncode(params[key])}`)
    .join('&');

  const stringToSign = `POST&${aliyunPercentEncode('/')}&${aliyunPercentEncode(canonicalizedQuery)}`;
  const signature = createHmac('sha1', `${accessKeySecret}&`).update(stringToSign, 'utf8').digest('base64');

  return {
    params,
    canonicalizedQuery,
    stringToSign,
    signature,
    // 真正发送的表单体：规范化查询串 + 末尾追加 Signature
    body: `${canonicalizedQuery}&Signature=${aliyunPercentEncode(signature)}`,
  };
}

/**
 * 生成阿里云 CreateToken（智能语音交互 Token）的 RPC 签名串。
 *
 * @param {{ accessKeyId: string, accessKeySecret: string, timestamp?: number|string|Date,
 *           regionId?: string, nonce?: string }} params
 * @returns {string} base64 形式的签名（Signature 参数值）
 */
export function buildAliyunTokenSignature({
  accessKeyId,
  accessKeySecret,
  timestamp,
  regionId = ALIYUN_DEFAULT_REGION,
  nonce,
} = {}) {
  if (isBlank(accessKeyId)) throw new CloudAsrError('阿里云鉴权参数不完整：缺少 AccessKey ID');
  if (isBlank(accessKeySecret)) throw new CloudAsrError('阿里云鉴权参数不完整：缺少 AccessKey Secret');

  // 同一个 timestamp 必须产出同一个 nonce，才能保证签名纯函数可复现
  const seconds = resolveTimestampSeconds(timestamp);
  const resolvedNonce = isBlank(nonce)
    ? buildDeterministicNonce(`${ALIYUN_TOKEN_ACTION}:${accessKeyId}:${seconds}`)
    : String(nonce);

  const { signature } = buildAliyunRpcRequest({
    action: ALIYUN_TOKEN_ACTION,
    version: ALIYUN_TOKEN_VERSION,
    regionId: isBlank(regionId) ? ALIYUN_DEFAULT_REGION : String(regionId),
    accessKeyId,
    accessKeySecret,
    timestamp: seconds,
    nonce: resolvedNonce,
  });
  return signature;
}

/* ======================= ⑤ 三家识别实现（内部） ======================= */

/** 讯飞返回的 JSON 里把 ws[].cw[].w 拼成整句 */
function extractIflytekText(result) {
  if (!result || !Array.isArray(result.ws)) return '';
  return result.ws
    .map((item) => {
      if (!item || !Array.isArray(item.cw)) return '';
      return item.cw.map((word) => (word && typeof word.w === 'string' ? word.w : '')).join('');
    })
    .join('');
}

/** 把 WebSocket 的 message 载荷统一解成字符串 */
function decodeWebSocketMessage(raw) {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  return String(raw);
}

/** 腾讯云一句话识别：临时热词表 `词|权重,词|权重`，最多 128 个、单词≤30 字符。 */
export function buildTencentHotwordList(hotwords) {
  const items = []
  const seen = new Set()
  for (const raw of Array.isArray(hotwords) ? hotwords : []) {
    const text = String(raw ?? '').replace(/[,|，；;]/g, '').trim()
    if (text === '' || text.length > 30 || seen.has(text)) continue
    seen.add(text)
    items.push(text + '|5')
    if (items.length >= 128) break
  }
  return items.join(',')
}

/** 阿里云热词表接口要求：中文≤10 字、英文≤5 词、中英混合≤10 字符，不含标点。 */
function buildAliyunWordWeights(hotwords) {
  const weights = {}
  let count = 0
  for (const raw of Array.isArray(hotwords) ? hotwords : []) {
    const text = String(raw ?? '').replace(/[，,。.、；;：:！!？?（）()【】\[\]「」"']/g, '').trim()
    if (text === '' || text.length > 10) continue
    if (weights[text] !== undefined) continue
    weights[text] = 3
    count += 1
    if (count >= 128) break
  }
  return weights
}

/** 阿里云已有词表 id 的缓存：key=akId|region，值={ vocabId, hash }（按热词内容哈希判断是否更新）。 */
const aliyunVocabCache = new Map()

/**
 * 把术语同步成阿里云热词表（Create / Update），返回 vocabulary_id；失败返回 ''（不阻断识别）。
 */
async function syncAliyunVocabulary({ config, region, hotwords, signal }) {
  try {
    const weights = buildAliyunWordWeights(hotwords)
    if (Object.keys(weights).length === 0) return ''
    const hash = createHash('sha256').update(JSON.stringify(weights)).digest('hex').slice(0, 16)
    const cacheKey = `${config.accessKeyId}|${region}`
    const cached = aliyunVocabCache.get(cacheKey)
    if (cached !== undefined && cached.hash === hash) return cached.vocabId
    const update = cached !== undefined && typeof cached.vocabId === 'string' && cached.vocabId !== ''
    const rpc = buildAliyunRpcRequest({
      action: update ? ALIYUN_VOCAB_UPDATE_ACTION : ALIYUN_VOCAB_CREATE_ACTION,
      version: ALIYUN_VOCAB_VERSION,
      regionId: region,
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: randomUUID(),
      extraParams: {
        ...(update ? { Id: cached.vocabId } : {}),
        Name: ALIYUN_VOCAB_NAME,
        Description: 'DSH meeting transcription terms',
        WordWeights: JSON.stringify(weights),
      },
    })
    const ctx = createRequestController(signal)
    try {
      const json = await requestJson(
        `https://nls-slp.${region}.aliyuncs.com/`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', Accept: 'application/json' },
          body: rpc.body,
          signal: ctx.signal,
        },
        '阿里云热词表',
      )
      if (json && json.Code) return cached?.vocabId ?? ''
      const vocabId = update ? cached.vocabId : (json && json.VocabId ? String(json.VocabId) : '')
      if (vocabId !== '') aliyunVocabCache.set(cacheKey, { vocabId, hash })
      return vocabId
    } finally {
      ctx.cleanup()
    }
  } catch {
    return ''
  }
}

/**
 * 科大讯飞实时听写（WebSocket v2/iat）。
 * 流程：建连 → 按 1280 字节切帧逐帧发送（首帧 status=0、中间 1、末帧 2）→ 收 JSON 拼接文字 → status=2 结束。
 */
function transcribeWithIflytek({ config, pcm, sampleRate, language, signal }) {
  return new Promise((resolve) => {
    if (typeof globalThis.WebSocket !== 'function') {
      resolve({ ok: false, error: '当前运行环境不支持 WebSocket，无法调用讯飞实时听写' });
      return;
    }

    const ctx = createRequestController(signal, 60_000);
    // 讯飞 iat 的语种/口音：中文用 zh_cn + mandarin，英文用 en_us + mandarin
    const isEnglish = String(language).toLowerCase().startsWith('en');
    const accent = 'mandarin';
    const lang = isEnglish ? 'en_us' : 'zh_cn';

    let socket = null;
    let settled = false;
    let sentAll = false;
    let text = '';

    const finish = (result) => {
      if (settled) return;
      settled = true;
      ctx.cleanup();
      try {
        if (socket && typeof socket.close === 'function') socket.close();
      } catch {
        /* 关闭失败无需处理 */
      }
      resolve(result);
    };

    ctx.signal.addEventListener('abort', () => {
      finish({
        ok: false,
        error: ctx.didTimeout()
          ? `讯飞识别超时（超过 ${REQUEST_TIMEOUT_MS / 1000} 秒未返回）`
          : '请求已取消',
      });
    });

    // 兜底：外部 signal 在创建控制器时已处于取消态，addEventListener 不会再触发
    if (ctx.signal.aborted) {
      finish({ ok: false, error: '请求已取消' });
      return;
    }

    let url;
    try {
      url = buildIflytekAuthUrl({
        host: IFLYTEK_HOST,
        path: IFLYTEK_PATH,
        apiKey: config.apiKey,
        apiSecret: config.apiSecret,
        date: new Date().toUTCString(),
      });
    } catch (error) {
      finish({ ok: false, error: toReadableError(error) });
      return;
    }

    try {
      socket = new WebSocket(url);
    } catch {
      finish({ ok: false, error: '讯飞 WebSocket 连接建立失败（请检查网络与鉴权配置）' });
      return;
    }

    socket.addEventListener('open', () => {
      // 讯飞 iat v2 协议：首帧必须带 common + business，后续帧只带 data。
      // data.status：0=首帧、1=中间帧、2=末帧；只有一帧时直接按末帧发送。
      // 注意：一次性把整段音频灌进 WebSocket 会被服务端丢弃大部分帧（实测仅识别前几秒），
      // 必须按 1280 字节/帧节流发送（10ms/帧 ≈ 4 倍速，30 秒音频约 7.5 秒发完）。
      const frameCount = Math.max(1, Math.ceil(pcm.length / IFLYTEK_FRAME_BYTES));
      const audioFormat = `audio/L16;rate=${sampleRate}`;
      let frameIndex = 0;
      let timer = null;
      const sendFrame = () => {
        if (settled) return;
        if (frameIndex >= frameCount) return;
        const index = frameIndex;
        frameIndex += 1;
        const start = index * IFLYTEK_FRAME_BYTES;
        const frame = pcm.subarray(start, Math.min(start + IFLYTEK_FRAME_BYTES, pcm.length));
        const isFirst = index === 0;
        const isLast = index === frameCount - 1;
        const status = isLast ? 2 : isFirst ? 0 : 1;

        const dataPayload = {
          status,
          format: audioFormat,
          encoding: 'raw',
          audio: frame.toString('base64'),
        };
        const message = isFirst
          ? {
            common: { app_id: config.appId },
            business: {
              language: lang,
              domain: 'iat',
              accent,
              // 关闭动态修正（dwa），保证结果按序追加、无需处理替换逻辑
              vad_eos: 10_000,
            },
            data: dataPayload,
          }
          : { data: dataPayload };
        try {
          socket.send(JSON.stringify(message));
        } catch {
          finish({ ok: false, error: '讯飞音频数据发送失败（连接已中断）' });
          return;
        }
        if (isLast) sentAll = true;
        if (!isLast) timer = setTimeout(sendFrame, IFLYTEK_FRAME_INTERVAL_MS);
      };
      try {
        sendFrame();
      } catch {
        finish({ ok: false, error: '讯飞音频数据发送失败（连接已中断）' });
        return;
      }
      // 连接被取消/关闭时清理发送定时器
      ctx.signal.addEventListener('abort', () => {
        if (timer !== null) clearTimeout(timer);
      });
    });

    socket.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(decodeWebSocketMessage(event.data));
      } catch {
        finish({ ok: false, error: '讯飞返回内容不是合法 JSON' });
        return;
      }
      if (payload && payload.code !== 0) {
        const detail = payload.message ? `（${sanitizeMessage(payload.message)}）` : '';
        finish({ ok: false, error: `讯飞识别失败：错误码 ${payload.code}${detail}` });
        return;
      }
      const data = payload && payload.data ? payload.data : null;
      if (data && data.result) text += extractIflytekText(data.result);
      // 讯飞会在「一句话结束」时先给出 status=2，但连接并未结束；必须等整段音频都发完，
      // 再收到 status=2 才是最终结果（否则会把长音频截断成第一句）。
      if (data && data.status === 2 && sentAll) finish({ ok: true, text: text.trim() });
    });

    socket.addEventListener('error', () => {
      finish({ ok: false, error: '讯飞 WebSocket 连接失败（请检查网络或鉴权配置）' });
    });

    socket.addEventListener('close', (event) => {
      if (settled) return;
      const code = event && event.code !== undefined ? event.code : '未知';
      // 服务端提前关闭但已经拿到部分结果时，保留已识别内容（长音频比报错更有用）。
      if (text.trim() !== '') {
        finish({ ok: true, text: text.trim() });
        return;
      }
      finish({ ok: false, error: `讯飞连接已关闭（code=${code}），未收到完整识别结果` });
    });
  });
}

/** 腾讯云一句话识别（SentenceRecognition），Data 传去掉 WAV 头后的裸 PCM */
async function transcribeWithTencent({ config, pcm, language, signal, hotwords = [] }) {
  const region = isBlank(config.region) ? 'ap-shanghai' : String(config.region);
  // engine 缺省按语言推导（16k_zh / 16k_en）
  const engine = isBlank(config.engine)
    ? (String(language).toLowerCase().startsWith('en') ? '16k_en' : '16k_zh')
    : String(config.engine);

  const payload = {
    EngSerViceType: engine,
    SourceType: 1,
    // Data 传的是去掉 WAV 头后的裸 PCM，必须声明 pcm；写 wav 会被服务端按容器解析而报错
    VoiceFormat: 'pcm',
    Data: pcm.toString('base64'),
    DataLen: pcm.length,
  };
  // 术语表 → 腾讯云临时热词表（HotwordList）：最多 128 个，权重 5；
  // 未配术语时不下发，避免空字符串被服务端判参数错误。
  const hotwordList = buildTencentHotwordList(hotwords);
  if (hotwordList !== '') payload.HotwordList = hotwordList;

  const auth = buildTencentHeaders({
    secretId: config.secretId,
    secretKey: config.secretKey,
    region,
    timestamp: Math.floor(Date.now() / 1000),
    action: TENCENT_ACTION,
    payload,
  });

  const headers = {
    Authorization: auth.authorization,
    'Content-Type': auth.contentType,
    'X-TC-Action': TENCENT_ACTION,
    'X-TC-Version': TENCENT_VERSION,
    'X-TC-Region': region,
    'X-TC-Timestamp': auth.timestamp,
  };

  const ctx = createRequestController(signal);
  try {
    const json = await requestJson(
      `https://${TENCENT_HOST}`,
      { method: 'POST', headers, body: JSON.stringify(payload), signal: ctx.signal },
      '腾讯云',
    );
    const response = json && json.Response ? json.Response : null;
    if (!response) throw new CloudAsrError('腾讯云识别失败：返回结果缺少 Response 字段');
    if (response.Error) {
      const code = response.Error.Code || '未知错误码';
      const message = response.Error.Message ? `（${sanitizeMessage(response.Error.Message)}）` : '';
      throw new CloudAsrError(`腾讯云识别失败：${code}${message}`);
    }
    if (typeof response.Result !== 'string') {
      throw new CloudAsrError('腾讯云识别失败：返回结果缺少 Result 字段');
    }
    return { ok: true, text: response.Result.trim() };
  } catch (error) {
    throw normalizeTransportError(error, ctx, '腾讯云');
  } finally {
    ctx.cleanup();
  }
}

/** 阿里云：先 CreateToken 取 Token，再调用一句话识别 HTTP 接口 */
/** 阿里云 Token 缓存：Token 有效期 24 小时，避免每次识别都重新 CreateToken（也避免 nonce 复用被拒）。 */
const aliyunTokenCache = new Map();

async function transcribeWithAliyun({ config, wavBuffer, sampleRate, signal, hotwords = [] }) {
  const region = isBlank(config.region) ? ALIYUN_DEFAULT_REGION : String(config.region);
  const metaHost = `nls-meta.${region}.aliyuncs.com`;
  const gatewayHost = `nls-gateway-${region}.aliyuncs.com`;

  /* ---------- 步骤一：CreateToken（带缓存） ---------- */
  const cacheKey = `${config.accessKeyId}|${region}`;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cached = aliyunTokenCache.get(cacheKey);
  let token = cached !== undefined && cached.expireAt > nowSeconds + 60 ? cached.token : '';
  const tokenCtx = createRequestController(signal);
  try {
    if (token === '') {
      const seconds = Math.floor(Date.now() / 1000);
      const rpc = buildAliyunRpcRequest({
        action: ALIYUN_TOKEN_ACTION,
        version: ALIYUN_TOKEN_VERSION,
        regionId: region,
        accessKeyId: config.accessKeyId,
        accessKeySecret: config.accessKeySecret,
        timestamp: seconds,
        // 每次请求必须用新的 SignatureNonce，重复值会被阿里云判为 400（不能用时间戳派生）。
        nonce: randomUUID(),
      });

      const json = await requestJson(
        `https://${metaHost}/`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
            Accept: 'application/json',
          },
          body: rpc.body,
          signal: tokenCtx.signal,
        },
        '阿里云 Token 服务',
      );

      if (json && json.Code) {
        const message = json.Message ? `（${sanitizeMessage(json.Message)}）` : '';
        throw new CloudAsrError(`阿里云获取 Token 失败：${json.Code}${message}`);
      }
      token = json && json.Token ? json.Token.Id : '';
      if (isBlank(token)) throw new CloudAsrError('阿里云获取 Token 失败：返回结果缺少 Token.Id');
      const expireAt = Number(json?.Token?.ExpireTime);
      aliyunTokenCache.set(cacheKey, {
        token,
        expireAt: Number.isFinite(expireAt) && expireAt > nowSeconds ? expireAt : nowSeconds + 3600,
      });
    }
  } catch (error) {
    throw normalizeTransportError(error, tokenCtx, '阿里云');
  } finally {
    tokenCtx.cleanup();
  }

  /* ---------- 步骤二：一句话识别 ---------- */
  const asrCtx = createRequestController(signal);
  try {
    // 术语表 → 阿里云热词表（vocabulary_id）；同步失败不影响识别
    const vocabularyId = await syncAliyunVocabulary({ config, region, hotwords, signal });
    const queryParams = {
      appkey: String(config.appKey),
      format: 'wav',
      sample_rate: String(sampleRate),
      enable_punctuation_prediction: 'true',
      enable_inverse_text_normalization: 'true',
    };
    if (vocabularyId !== '') queryParams.vocabulary_id = vocabularyId;
    const query = new URLSearchParams(queryParams);
    const json = await requestJson(
      `https://${gatewayHost}/stream/v1/asr?${query.toString()}`,
      {
        method: 'POST',
        headers: {
          'X-NLS-Token': token,
          'Content-Type': 'application/octet-stream',
        },
        body: wavBuffer,
        signal: asrCtx.signal,
      },
      '阿里云语音识别',
    );

    const status = json ? json.status : undefined;
    if (status !== 20_000_000) {
      const message = json && json.message ? `（${sanitizeMessage(json.message)}）` : '';
      throw new CloudAsrError(`阿里云识别失败：status=${status === undefined ? '未知' : status}${message}`);
    }
    if (typeof json.result !== 'string') {
      throw new CloudAsrError('阿里云识别失败：返回结果缺少 result 字段');
    }
    return { ok: true, text: json.result.trim() };
  } catch (error) {
    throw normalizeTransportError(error, asrCtx, '阿里云');
  } finally {
    asrCtx.cleanup();
  }
}

/* ========================= ⑤ 统一入口 ========================= */

/**
 * 云端语音识别统一入口。
 *
 * @param {object} options
 * @param {'iflytek'|'tencent'|'aliyun'} options.provider 服务商
 * @param {object} options.config 该服务商的配置（见 validateCloudConfig）
 * @param {Buffer} options.wavBuffer 16k 单声道 PCM16 WAV（含文件头）
 * @param {number} [options.sampleRate=16000] 采样率
 * @param {string} [options.language='zh'] 语言标识（zh / en，用于引擎与语种推导）
 * @param {AbortSignal} [options.signal] 外部取消信号
 * @returns {Promise<{ ok: true, text: string } | { ok: false, error: string }>}
 */
export async function transcribeCloud({
  provider,
  config,
  wavBuffer,
  sampleRate = 16000,
  language = 'zh',
  signal,
  hotwords = [],
} = {}) {
  // ① 配置校验（三家必填字段）
  const configCheck = validateCloudConfig(provider, config);
  if (!configCheck.ok) return configCheck;

  // ② 音频校验：非 Buffer / 空 / 非 RIFF 头 / 无 PCM 数据一律拒绝
  const wav = parseWavHeader(wavBuffer);
  if (!wav) return { ok: false, error: INVALID_AUDIO_ERROR };
  const pcm = wav.buffer.subarray(wav.dataOffset, wav.dataOffset + wav.dataLength);

  // ③ 外部已取消则不再发起请求
  if (signal && signal.aborted) return { ok: false, error: '请求已取消' };

  const rate = Number.isFinite(Number(sampleRate)) && Number(sampleRate) > 0 ? Math.floor(Number(sampleRate)) : 16000;
  const lang = isBlank(language) ? 'zh' : String(language).trim().toLowerCase();

  // 四、时长保护：三家一句话识别都限制单次 60 秒（腾讯另有 3MB、阿里 2MB 上限）。
  // 插件侧已按 55 秒切片；这里再兜一层，避免把超长音频直接发给服务端换回难懂的报错。
  const seconds = pcm.length / (rate * 2);
  if (seconds > 60) {
    return {
      ok: false,
      error: `音频过长（${seconds.toFixed(1)} 秒）：云端一句话识别单次上限 60 秒，请先切片后再识别`,
    };
  }

  try {
    if (provider === 'iflytek') {
      return await transcribeWithIflytek({ config, pcm, sampleRate: rate, language: lang, signal });
    }
    if (provider === 'tencent') {
      return await transcribeWithTencent({ config, pcm, language: lang, signal, hotwords });
    }
    if (provider === 'aliyun') {
      return await transcribeWithAliyun({ config, wavBuffer: wav.buffer, sampleRate: rate, language: lang, signal, hotwords });
    }
    return { ok: false, error: `不支持的云服务商：${String(provider)}` };
  } catch (error) {
    return { ok: false, error: toReadableError(error) };
  }
}

