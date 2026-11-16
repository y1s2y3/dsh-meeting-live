/**
 * 本地「Paraformer + cam++」语音引擎（sherpa-onnx）。
 *
 * 与内置 SenseVoice 的区别：
 * - 识别模型换成 Paraformer（中文长句/专业词更稳）；
 * - 额外用 pyannote 分段 + cam++ 声纹做**真说话人分离**（不是靠音高猜）；
 * - 整段音频跑一次分离，得到「说话人编号 + 起止时间 + 文本」。
 *
 * sherpa-onnx-node 随 DSH 桌面端安装（app/node_modules），插件通过
 * createRequire 从应用目录解析，避免额外依赖。
 *
 * @module dsh-meeting-live/paraformer
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 解析 sherpa-onnx-node：从 DSH 应用目录 require。 */
function loadSherpa() {
  const candidates = []
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    candidates.push(join(process.resourcesPath, 'app', 'package.json'))
  }
  const localAppData = process.env.LOCALAPPDATA ?? ''
  if (localAppData !== '') {
    candidates.push(join(localAppData, 'Programs', 'DSH Desktop', 'resources', 'app', 'package.json'))
  }
  if (typeof process.execPath === 'string' && process.execPath !== '') {
    candidates.push(join(dirname(process.execPath), 'resources', 'app', 'package.json'))
  }
  for (const anchor of candidates) {
    if (!existsSync(anchor)) continue
    try {
      const require = createRequire(anchor)
      return require('sherpa-onnx-node')
    } catch {
      // 换下一个候选
    }
  }
  throw new Error('没有找到本机语音引擎（sherpa-onnx-node），无法使用 Paraformer 本地转写')
}

/** 解析 16k 单声道 PCM16 WAV → Float32Array（[-1,1]）。 */
export function decodeWavToSamples(buffer) {
  // 兼容 Uint8Array：HTTP 路由历史上有返回 Uint8Array 的情况，不能只认 Buffer。
  const wav = Buffer.isBuffer(buffer)
    ? buffer
    : (buffer instanceof Uint8Array ? Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength) : null)
  if (!wav || wav.length < 44) throw new Error('音频数据无效')
  buffer = wav
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('音频数据不是 WAV 格式')
  }
  let offset = 12
  let sampleRate = 16000
  let channels = 1
  let bits = 16
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(body + 2)
      sampleRate = buffer.readUInt32LE(body + 4)
      bits = buffer.readUInt16LE(body + 14)
    } else if (id === 'data') {
      const available = Math.min(size, buffer.length - body)
      if (bits !== 16) throw new Error('只支持 16bit PCM WAV')
      const frames = Math.floor(available / 2 / channels)
      const out = new Float32Array(frames)
      for (let frame = 0; frame < frames; frame += 1) {
        const index = body + frame * 2 * channels
        out[frame] = buffer.readInt16LE(index) / 32768
      }
      return { samples: out, sampleRate, channels }
    }
    offset = body + size + (size % 2)
  }
  throw new Error('音频数据里没有找到 PCM 数据段')
}

/** 简易线性重采样（目标 16k）。 */
function to16k(samples, sampleRate) {
  if (sampleRate === 16000) return samples
  const ratio = sampleRate / 16000
  const length = Math.max(1, Math.floor(samples.length / ratio))
  const out = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio
    const left = Math.floor(position)
    const right = Math.min(samples.length - 1, left + 1)
    const weight = position - left
    out[index] = samples[left] * (1 - weight) + samples[right] * weight
  }
  return out
}

/** 读音频文件为 16k float32 样本。 */
export function readAudioFile(path) {
  const buffer = readFileSync(path)
  const decoded = decodeWavToSamples(buffer)
  if (decoded.channels !== 1) {
    // 多声道混成单声道
    const mono = new Float32Array(Math.floor(decoded.samples.length / decoded.channels))
    for (let index = 0; index < mono.length; index += 1) {
      let sum = 0
      for (let channel = 0; channel < decoded.channels; channel += 1) {
        sum += decoded.samples[index * decoded.channels + channel] ?? 0
      }
      mono[index] = sum / decoded.channels
    }
    return { samples: to16k(mono, decoded.sampleRate), sampleRate: 16000 }
  }
  return { samples: to16k(decoded.samples, decoded.sampleRate), sampleRate: 16000 }
}

/**
 * 创建本地 Paraformer 引擎。
 * @param options - `{ models, logger }`；models 形如：
 *   `{ paraformer: { model, tokens }, segmentation: { model }, campplus: { model } }`。
 */
export function createParaformerEngine(options = {}) {
  const logger = options.logger
  const models = options.models ?? {}
  let sherpa = null
  let recognizer = null
  let diarizer = null

  const paraformerModel = models.paraformer?.model ?? ''
  const paraformerTokens = models.paraformer?.tokens ?? ''
  const segmentationModel = models.segmentation?.model ?? ''
  const campplusModel = models.campplus?.model ?? ''

  /** 模型是否齐全。 */
  function available() {
    return existsSync(paraformerModel) && existsSync(paraformerTokens)
  }

  /** 说话人分离模型是否齐全。 */
  function diarizationAvailable() {
    return available() && existsSync(segmentationModel) && existsSync(campplusModel)
  }

  function ensureSherpa() {
    if (sherpa !== null) return sherpa
    sherpa = loadSherpa()
    return sherpa
  }

  function ensureRecognizer() {
    if (recognizer !== null) return recognizer
    if (!available()) throw new Error('Paraformer 模型还没下载：请到设置 → 模型配置里下载')
    const lib = ensureSherpa()
    recognizer = new lib.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        paraformer: { model: paraformerModel },
        tokens: paraformerTokens,
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
    })
    logger?.info?.('meeting-minutes: paraformer recognizer loaded')
    return recognizer
  }

  function ensureDiarizer() {
    if (diarizer !== null) return diarizer
    if (!diarizationAvailable()) throw new Error('说话人分离模型还没下载：请到设置 → 模型配置里下载')
    const lib = ensureSherpa()
    diarizer = new lib.OfflineSpeakerDiarization({
      segmentation: { pyannote: { model: segmentationModel }, numThreads: 2, provider: 'cpu', debug: 0 },
      embedding: { model: campplusModel, numThreads: 2, provider: 'cpu', debug: 0 },
      clustering: { numClusters: -1, threshold: 0.5 },
      minDurationOn: 0.25,
      minDurationOff: 0.5,
    })
    logger?.info?.('meeting-minutes: speaker diarization loaded (pyannote + cam++)')
    return diarizer
  }

  /** 识别一段 16k float32 样本。 */
  function recognizeSamples(samples) {
    const engine = ensureRecognizer()
    const stream = engine.createStream()
    stream.acceptWaveform({ samples, sampleRate: 16000 })
    engine.decode(stream)
    const result = engine.getResult(stream)
    return typeof result?.text === 'string' ? result.text.trim() : ''
  }

  /**
   * 转写一段 WAV（保持与内置引擎一致的返回形状）。
   * @param bytes - WAV Buffer。
   * @returns `{ text, audioSeconds, inferenceSeconds }`。
   */
  async function transcribeWav(bytes) {
    const started = Date.now()
    const decoded = decodeWavToSamples(bytes)
    const samples = to16k(decoded.samples, decoded.sampleRate)
    const audioSeconds = Math.round((samples.length / 16000) * 100) / 100
    const text = recognizeSamples(samples)
    if (text === '') throw new Error('语音识别没有识别出任何文字')
    return { text, audioSeconds, inferenceSeconds: Math.round((Date.now() - started) / 100) / 10 }
  }

  /**
   * 对整段音频做说话人分离 + 逐段识别。
   * @param samples - 16k float32 样本。
   * @returns `{ speakers, segments: [{ start, end, speaker, text }], text }`。
   */
  function transcribeWithSpeakers(samples) {
    const engine = ensureDiarizer()
    const segments = engine.process(samples)
    const rows = []
    for (const segment of Array.isArray(segments) ? segments : []) {
      const start = Math.max(0, Number(segment.start))
      const end = Math.max(start, Number(segment.end))
      const speakerIndex = Number(segment.speaker)
      const from = Math.floor(start * 16000)
      const to = Math.min(samples.length, Math.floor(end * 16000))
      if (to - from < 1600) continue
      const slice = samples.subarray(from, to)
      let text = ''
      try {
        text = recognizeSamples(slice)
      } catch {
        text = ''
      }
      if (text === '') continue
      rows.push({ start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10, speakerIndex: Number.isFinite(speakerIndex) ? speakerIndex : 0, text })
    }
    // 合并同一说话人相邻且间隔很短的段
    const merged = []
    for (const row of rows) {
      const previous = merged[merged.length - 1]
      if (previous !== undefined && previous.speakerIndex === row.speakerIndex && row.start - previous.end <= 1.2) {
        previous.end = row.end
        previous.text = `${previous.text}${/[。！？,，]$/.test(previous.text) ? '' : '，'}${row.text}`
        continue
      }
      merged.push({ ...row })
    }
    const label = (index) => `S${index + 1}`
    const speakers = [...new Set(merged.map((row) => row.speakerIndex))].sort((a, b) => a - b)
    const lines = merged.map((row) => ({ speaker: label(row.speakerIndex), text: row.text, start: row.start, end: row.end }))
    return {
      speakers: speakers.length,
      lines,
      text: lines.map((line) => `${line.speaker}：${line.text}`).join('\n'),
    }
  }

  /** 按文件路径做说话人分离 + 逐段识别。 */
  function transcribeFileWithSpeakers(filePath) {
    const { samples } = readAudioFile(filePath)
    return transcribeWithSpeakers(samples)
  }

  return { available, diarizationAvailable, transcribeWav, transcribeWithSpeakers, transcribeFileWithSpeakers, decodeWavToSamples }
}
