/**
 * 录音质量分析（宿主侧，纯函数）：
 * 输入 16bit PCM WAV，输出音量、峰值、削波、底噪、信噪比、静音占比与中文建议。
 * 用于在录音上传后提醒「麦克风太远 / 声音太小 / 有爆音 / 环境太吵」。
 *
 * @module dsh-meeting-live/audio-quality
 */

const WINDOW_SECONDS = 0.05;

/** 把 WAV Buffer 解成单声道 Float32 采样；失败返回 null。 */
function readWavSamples(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null
  let offset = 12
  let format = null
  let channels = 1
  let sampleRate = 16000
  let bits = 16
  let data = null
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      format = buffer.readUInt16LE(body)
      channels = buffer.readUInt16LE(body + 2) || 1
      sampleRate = buffer.readUInt32LE(body + 4) || 16000
      bits = buffer.readUInt16LE(body + 14) || 16
    } else if (id === 'data') {
      data = buffer.subarray(body, Math.min(buffer.length, body + size))
    }
    offset = body + size + (size % 2)
  }
  if (format !== 1 || bits !== 16 || data === null) return null
  const totalSamples = Math.floor(data.length / 2)
  const frames = Math.floor(totalSamples / channels)
  const samples = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    // 多声道取平均，避免单声道文件被误判
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) {
      sum += data.readInt16LE((frame * channels + channel) * 2) / 32768
    }
    samples[frame] = sum / channels
  }
  return { samples, sampleRate, channels }
}

function toDb(value) {
  if (!Number.isFinite(value) || value <= 0) return -120
  return Math.max(-120, 20 * Math.log10(value))
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))
  return sorted[index]
}

/**
 * 分析 WAV 的录音质量。
 * @param buffer - 16bit PCM WAV Buffer。
 * @returns `{ level, summary, suggestions, metrics }` 或 null（非 PCM16 WAV）。
 */
export function analyzeWavQuality(buffer) {
  const parsed = readWavSamples(buffer)
  if (parsed === null) return null
  const { samples, sampleRate } = parsed
  if (samples.length === 0) return null
  const durationSeconds = samples.length / sampleRate

  let sumSq = 0
  let peak = 0
  let clipped = 0
  for (const sample of samples) {
    const value = Math.abs(sample)
    sumSq += sample * sample
    if (value > peak) peak = value
    if (value >= 0.98) clipped += 1
  }
  const rms = Math.sqrt(sumSq / samples.length)
  const peakDbfs = toDb(peak)
  const rmsDbfs = toDb(rms)
  const clippingRatio = clipped / samples.length

  // 50ms 窗能量：用第 10 百分位估算底噪、第 90 百分位估算说话电平
  const windowSize = Math.max(1, Math.round(sampleRate * WINDOW_SECONDS))
  const windowLevels = []
  for (let start = 0; start + windowSize <= samples.length; start += windowSize) {
    let windowSq = 0
    for (let index = start; index < start + windowSize; index += 1) windowSq += samples[index] * samples[index]
    windowLevels.push(toDb(Math.sqrt(windowSq / windowSize)))
  }
  windowLevels.sort((a, b) => a - b)
  const noiseDbfs = percentile(windowLevels, 0.1)
  const speechDbfs = percentile(windowLevels, 0.9)
  const snrDb = Math.max(0, speechDbfs - noiseDbfs)
  const silenceThreshold = speechDbfs - 25
  const silentWindows = windowLevels.filter((level) => level < silenceThreshold).length
  const silenceRatio = windowLevels.length === 0 ? 1 : silentWindows / windowLevels.length

  const suggestions = []
  let level = 'good'
  const demote = (next) => { if (next === 'poor' || level === 'good') level = next }

  if (rmsDbfs < -45) {
    demote('poor')
    suggestions.push('几乎听不到声音：检查是否选错麦克风、麦克风被静音或离得太远')
  } else if (rmsDbfs < -35) {
    demote('fair')
    suggestions.push('声音偏小：把麦克风靠近说话人，或在系统声音设置里把输入音量调大')
  } else if (rmsDbfs > -8) {
    demote('fair')
    suggestions.push('音量偏大/可能爆音：把输入音量调小一档，避免声音削顶')
  }
  if (clippingRatio > 0.005) {
    level = 'poor'
    suggestions.push('有明显爆音（削波）：降低麦克风增益，或让说话人离麦稍远')
  }
  if (snrDb < 10) {
    demote(snrDb < 6 ? 'poor' : 'fair')
    suggestions.push('环境噪声偏大：关掉空调/风扇或换安静房间，靠近麦克风说话')
  } else if (snrDb < 18) {
    demote('fair')
    suggestions.push('底噪略高：可以试试外接会议麦或开启系统降噪')
  }
  if (silenceRatio > 0.92 && durationSeconds > 20) {
    demote('fair')
    suggestions.push('静音占比很高：确认会议内容确实很少，或麦克风是否离得太远')
  }

  const summary = level === 'good'
    ? '录音质量良好（音量 ' + rmsDbfs.toFixed(1) + ' dBFS，信噪比约 ' + snrDb.toFixed(0) + ' dB）'
    : '录音质量' + (level === 'poor' ? '较差' : '一般') + '：' + (suggestions[0] ?? '建议检查麦克风')

  return {
    level,
    summary,
    suggestions: suggestions.slice(0, 3),
    metrics: {
      durationSeconds: Math.round(durationSeconds * 10) / 10,
      rmsDbfs: Math.round(rmsDbfs * 10) / 10,
      peakDbfs: Math.round(peakDbfs * 10) / 10,
      snrDb: Math.round(snrDb * 10) / 10,
      noiseDbfs: Math.round(noiseDbfs * 10) / 10,
      clippingRatio: Math.round(clippingRatio * 10000) / 10000,
      silenceRatio: Math.round(silenceRatio * 1000) / 1000,
    },
  }
}
