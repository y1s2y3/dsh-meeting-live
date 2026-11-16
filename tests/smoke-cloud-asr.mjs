/**
 * 云端语音识别离线集成测试（不联网、不需要真实密钥）。
 *
 * 验证的是「请求构造 + 响应解析 + 错误处理」这条链路是否真的跑得通：
 *   1) 三家配置校验（缺字段的中文提示、未知服务商）
 *   2) WAV 解析与 60 秒上限保护
 *   3) 科大讯飞：wss 鉴权 URL（HMAC-SHA256 可复算）、帧格式（1280B / status 0-1-2）、结果拼接、错误码
 *   4) 腾讯云：TC3 签名头、请求体（VoiceFormat=pcm / DataLen / 引擎）、Result 解析、错误码
 *   5) 阿里云：CreateToken RPC 签名请求、Token 解析、一句话识别 query/header/body、结果解析、错误码
 *
 * 用法：node tests/smoke-cloud-asr.mjs
 * 说明：真实调用（含鉴权与计费）必须用真实密钥；本测试用 mock fetch / WebSocket 覆盖协议层。
 */
import path from 'node:path'
import { createHmac } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'src', 'lib')
const cloud = await import(pathToFileURL(path.join(SRC, 'cloud-asr.js')).href)

let failures = 0
function check(label, condition, detail) {
  const ok = !!condition
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  :: ' + detail}`)
}

/** 生成 16k 单声道 PCM16 WAV（静音，足够用来测协议层）。 */
function makeWav(seconds, sampleRate = 16000, channels = 1) {
  const frames = Math.round(seconds * sampleRate) * channels
  const data = Buffer.alloc(frames * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket

/* ── 1. 配置校验 ─────────────────────────────────────────────── */
{
  const cases = [
    ['iflytek', { apiKey: 'k', apiSecret: 's' }, 'appId'],
    ['tencent', { secretId: 'id' }, 'SecretKey'],
    ['aliyun', { appKey: 'a', accessKeyId: 'i' }, 'AccessKey Secret'],
  ]
  for (const [provider, config, missing] of cases) {
    const result = cloud.validateCloudConfig(provider, config)
    check(`${provider} 缺字段给出中文提示`, result.ok === false && result.error.includes(missing), result.error)
  }
  check('阿里云完整配置通过校验', cloud.validateCloudConfig('aliyun', { appKey: 'a', accessKeyId: 'i', accessKeySecret: 's' }).ok === true)
  check('未知服务商被拒绝', cloud.validateCloudConfig('unknown', {}).ok === false)
}

/* ── 2. 音频校验 + 60 秒上限保护 ─────────────────────────────── */
{
  const bad = await cloud.transcribeCloud({ provider: 'tencent', config: { secretId: 'a', secretKey: 'b' }, wavBuffer: Buffer.from('not wav') })
  check('非 WAV 音频被拒绝', bad.ok === false && bad.error.includes('音频数据无效'), bad.error)
  const tooLong = await cloud.transcribeCloud({ provider: 'tencent', config: { secretId: 'a', secretKey: 'b' }, wavBuffer: makeWav(61) })
  check('超过 60 秒的音频在本地就被拦下（三家上限）', tooLong.ok === false && tooLong.error.includes('60 秒'), tooLong.error)
}

/* ── 3. 讯飞：鉴权 URL + 帧格式 + 结果拼接 + 错误码 ─────────── */
{
  const date = 'Thu, 13 Nov 2026 10:00:00 GMT'
  const url = new URL(cloud.buildIflytekAuthUrl({ apiKey: 'key-123', apiSecret: 'secret-456', date }))
  check('讯飞使用 wss + iat-api.xfyun.cn/v2/iat', url.protocol === 'wss:' && url.host === 'iat-api.xfyun.cn' && url.pathname === '/v2/iat', url.origin + url.pathname)
  check('讯飞 URL 带 authorization/date/host 三个参数', ['authorization', 'date', 'host'].every((key) => url.searchParams.has(key)))
  const expectedSignature = createHmac('sha256', 'secret-456')
    .update(`host: iat-api.xfyun.cn\ndate: ${date}\nGET /v2/iat HTTP/1.1`, 'utf8')
    .digest('base64')
  const authorization = Buffer.from(url.searchParams.get('authorization'), 'base64').toString('utf8')
  check('讯飞鉴权串签名可按官方算法复算', authorization.includes(`signature="${expectedSignature}"`), authorization.slice(0, 80) + '…')

  const frames = []
  class FakeWebSocket {
    constructor(target) {
      this.url = target
      this.listeners = new Map()
      FakeWebSocket.last = this
      setTimeout(() => this.emit('open', {}), 0)
    }
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, [])
      this.listeners.get(type).push(handler)
    }
    emit(type, event) {
      for (const handler of this.listeners.get(type) ?? []) handler(event)
    }
    send(text) { frames.push(JSON.parse(text)) }
    close() { /* 由测试驱动 message 事件 */ }
  }
  globalThis.WebSocket = FakeWebSocket

  const wav = makeWav(1)
  const pendingOk = cloud.transcribeCloud({
    provider: 'iflytek',
    config: { appId: 'app-1', apiKey: 'key-123', apiSecret: 'secret-456' },
    wavBuffer: wav,
  })
  await new Promise((resolve) => setTimeout(resolve, 600))
  check('讯飞按 1280 字节切帧发送', frames.length === Math.max(1, Math.ceil((wav.length - 44) / 1280)), `${frames.length} 帧`)
  check('讯飞首帧 status=0、末帧 status=2', frames.length > 0 && frames[0].data.status === 0 && frames[frames.length - 1].data.status === 2)
  check('讯飞首帧带 common.app_id / business.zh_cn / audio/L16', frames[0].common?.app_id === 'app-1' && frames[0].business?.language === 'zh_cn' && String(frames[0].data.format).includes('audio/L16;rate=16000'), JSON.stringify(frames[0].business))
  check('讯飞中间帧只带 data（符合 iat v2 协议）', frames.slice(1).every((frame) => frame.common === undefined && frame.business === undefined && frame.data !== undefined))
  check('讯飞音频帧是裸 PCM 的 base64', Buffer.from(frames[0].data.audio, 'base64').length > 0)
  FakeWebSocket.last.emit('message', { data: JSON.stringify({ code: 0, data: { status: 1, result: { ws: [{ cw: [{ w: '大家' }] }] } } }) })
  FakeWebSocket.last.emit('message', { data: JSON.stringify({ code: 0, data: { status: 2, result: { ws: [{ cw: [{ w: '好' }] }] } } }) })
  const iflytekOk = await pendingOk
  check('讯飞结果按序拼接', iflytekOk.ok === true && iflytekOk.text === '大家好', JSON.stringify(iflytekOk))

  const pendingError = cloud.transcribeCloud({
    provider: 'iflytek',
    config: { appId: 'app-1', apiKey: 'key-123', apiSecret: 'secret-456' },
    wavBuffer: wav,
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  FakeWebSocket.last.emit('message', { data: JSON.stringify({ code: 10105, message: 'invalid authorization' }) })
  const iflytekError = await pendingError
  check('讯飞错误码原样透出（不含密钥）', iflytekError.ok === false && iflytekError.error.includes('10105') && !iflytekError.error.includes('secret-456'), iflytekError.error)
}

/* ── 4. 腾讯云：签名头 + 请求体 + 结果/错误解析 ─────────────── */
{
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options, body: JSON.parse(String(options.body)) })
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ Response: { Result: ' 腾讯云识别结果 ', RequestId: 'r1' } }),
    }
  }
  const wav = makeWav(5)
  const result = await cloud.transcribeCloud({
    provider: 'tencent',
    config: { secretId: 'AKIDtest', secretKey: 'secretKeyTest' },
    wavBuffer: wav,
  })
  check('腾讯云请求到 asr.tencentcloudapi.com', calls.length === 1 && calls[0].url.replace(/\/+$/, '') === 'https://asr.tencentcloudapi.com', calls[0]?.url)
  check('腾讯云请求体 VoiceFormat=pcm（回归修复）', calls[0]?.body.VoiceFormat === 'pcm', String(calls[0]?.body.VoiceFormat))
  check('腾讯云请求体 SourceType=1、DataLen=PCM 长度、引擎 16k_zh', calls[0]?.body.SourceType === 1 && calls[0]?.body.DataLen === wav.length - 44 && calls[0]?.body.EngSerViceType === '16k_zh', JSON.stringify({ source: calls[0]?.body.SourceType, len: calls[0]?.body.DataLen }))
  check('腾讯云 Authorization 为 TC3-HMAC-SHA256', String(calls[0]?.options.headers.Authorization).startsWith('TC3-HMAC-SHA256 Credential=AKIDtest/'), String(calls[0]?.options.headers.Authorization).slice(0, 48))
  check('腾讯云结果去除首尾空白', result.ok === true && result.text === '腾讯云识别结果', JSON.stringify(result))

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify({ Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: 'signature error' } } }),
  })
  const errorResult = await cloud.transcribeCloud({
    provider: 'tencent',
    config: { secretId: 'AKIDtest', secretKey: 'secretKeyTest' },
    wavBuffer: wav,
  })
  check('腾讯云错误码与信息透出', errorResult.ok === false && errorResult.error.includes('AuthFailure.SignatureFailure'), errorResult.error)
}

/* ── 5. 阿里云：CreateToken → 一句话识别 ───────────────────── */
{
  const calls = []
  globalThis.fetch = async (url, options) => {
    const text = String(url)
    calls.push({ url: text, options })
    if (text.includes('nls-meta')) {
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ Token: { Id: 'tok-123', ExpireTime: 3600 } }) }
    }
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ status: 20000000, result: '阿里云识别结果', task_id: 't1' }) }
  }
  const wav = makeWav(5)
  const result = await cloud.transcribeCloud({
    provider: 'aliyun',
    config: { appKey: 'appkey-test', accessKeyId: 'AK', accessKeySecret: 'SK' },
    wavBuffer: wav,
  })
  check('阿里云先请求 nls-meta 取 Token', calls.length === 2 && calls[0].url.includes('nls-meta.cn-shanghai.aliyuncs.com/'), calls[0]?.url)
  check('阿里云 CreateToken 为 RPC 表单（含 Action/Signature）', String(calls[0]?.options.body).includes('Action=CreateToken') && String(calls[0]?.options.body).includes('Signature='), String(calls[0]?.options.body).slice(0, 80))
  check('阿里云识别请求到 nls-gateway 且带 appkey/format/sample_rate', calls[1]?.url.includes('nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/asr') && calls[1]?.url.includes('appkey=appkey-test') && calls[1]?.url.includes('format=wav') && calls[1]?.url.includes('sample_rate=16000'), calls[1]?.url)
  check('阿里云请求头带 X-NLS-Token 与音频 body', calls[1]?.options.headers['X-NLS-Token'] === 'tok-123' && Buffer.isBuffer(calls[1]?.options.body) && calls[1].options.body.length === wav.length)
  check('阿里云结果解析正常', result.ok === true && result.text === '阿里云识别结果', JSON.stringify(result))

  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ Code: 'InvalidAccessKeyId.NotFound', Message: 'specified access key is not found' }) })
  const errorResult = await cloud.transcribeCloud({
    provider: 'aliyun',
    config: { appKey: 'appkey-test', accessKeyId: 'AK2', accessKeySecret: 'SK' },
    wavBuffer: wav,
  })
  check('阿里云 Token 错误码与信息透出', errorResult.ok === false && errorResult.error.includes('InvalidAccessKeyId.NotFound'), errorResult.error)
}

globalThis.fetch = originalFetch
globalThis.WebSocket = originalWebSocket

console.log(failures === 0 ? '\nALL CLOUD ASR CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
