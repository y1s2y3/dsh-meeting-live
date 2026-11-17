/**
 * Local HTTP surface for the meeting-minutes plugin's browser half.
 *
 * The panel is a hand-written client bundle: it cannot use the generated Typert
 * Remote channel (that assembly is fixed at build time), so the host half claims
 * one prefix route on `ctx.webServer` and the bundle talks to it with plain
 * `fetch`. Everything is loopback-only, same-origin, and JSON in/JSON out — the
 * transcription route is the single binary exception (canonical 16kHz WAV).
 *
 * @module dsh-meeting-live/server
 */

import { buildCorrectionContext, formatMoment, isGenericTitle, localDay, projectMeeting, todoProgress } from './model.js'
import { analyzeWavQuality } from './audio-quality.js'
import { applyCorrectionChanges, diffTextLines } from './text-diff.js'
import { sortMeetings } from './store.js'
import { exportMeeting } from './export.js'
import {
  CLOUD_PROVIDERS,
  TRANSCRIBE_PROVIDERS,
  effectiveTerms,
  normalizeTermItems,
  parseTerms,
  validateCloudSettings,
  validateSummaryCustom,
} from './settings.js'
import { scanFolders } from './term-extract.js'
import {
  dropTempVideo,
  isCapturing,
  listScreenSources,
  muxScreenWithAudio,
  identifyScreen,
  startScreenCapture,
  stopScreenCapture,
  takePendingVideo,
} from './screen.js'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { CURRENT_VERSION, checkForUpdate } from './update-check.js'

const execFileAsync = promisify(execFile)

/** 本文件所在目录；插件资源（示例图等）在其上一级 resources/ 里。 */
const HERE = dirname(fileURLToPath(import.meta.url))
const RESOURCES_DIR = join(HERE, '..', 'resources')

/** Registered prefix; the client builds its URLs from the same constant. */
export const ROUTE_PREFIX = '/dsh-meeting'

/** 把任意文本包成 PowerShell 单引号字符串（内部单引号翻倍）。 */
function psQuote(text) {
  return `'${String(text ?? '').replace(/'/g, "''")}'`
}

/**
 * 弹系统「选择文件夹」对话框，返回绝对路径；用户取消时返回空字符串。
 * Windows 用 PowerShell + FolderBrowserDialog（用一个不可见的置顶宿主窗口，
 * 避免对话框弹到 DSH 窗口后面），macOS 用 osascript 的 choose folder。
 * @param title - 对话框说明文字。
 */
async function pickFolder(title) {
  const prompt = typeof title === 'string' && title.trim() !== '' ? title.trim() : '选择文件夹'
  if (process.platform === 'win32') {
    // PowerShell 5.1 的 stdout 走系统 ANSI 代码页（中文 Windows 是 GBK），
    // 直接 Write-Output 中文路径会被 Node 按 UTF-8 解码成乱码（����ƽ̨2��）。
    // 所以让 PowerShell 用 UTF-8 写临时文件，Node 再按 UTF-8 读回来。
    const outFile = join(tmpdir(), 'dsh-pick-dir-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.txt')
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      `$outFile = ${psQuote(outFile)}`,
      '$owner = New-Object System.Windows.Forms.Form',
      '$owner.Text = "选择目录"',
      '$owner.TopMost = $true',
      '$owner.ShowInTaskbar = $false',
      '$owner.MinimizeBox = $false',
      '$owner.MaximizeBox = $false',
      '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
      '$owner.Width = 1',
      '$owner.Height = 1',
      '$owner.Opacity = 0',
      '$owner.Show() | Out-Null',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$dialog.Description = ${psQuote(prompt)}`,
      '$dialog.ShowNewFolderButton = $false',
      'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
      '  [System.IO.File]::WriteAllText($outFile, $dialog.SelectedPath, (New-Object System.Text.UTF8Encoding($false)))',
      '}',
      '$owner.Close()',
    ].join('\n')
    try {
      await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeout: 300_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      )
      const picked = await readFile(outFile, 'utf8').catch(() => '')
      return picked.trim()
    } finally {
      await rm(outFile, { force: true }).catch(() => {})
    }
  }
  if (process.platform === 'darwin') {
    const script = `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 300_000 })
      return String(stdout ?? '').trim().replace(/\/+$/, '')
    } catch (error) {
      const stderr = String(error?.stderr ?? '')
      if (/User canceled|-128/.test(stderr)) return ''
      throw error
    }
  }
  throw new Error('当前系统不支持自动选择目录，请手动输入路径')
}

/** JSON 响应 helper。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Read a JSON request body (bounded). */
async function readJsonBody(req, limit = 2 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be an object')
    return parsed
  } catch (error) {
    throw new Error(`请求体不是合法 JSON：${String(error?.message ?? error)}`)
  }
}

/** 录制文件存放目录：<dsh-home>/storages/meeting-minutes-media/<meetingId>/ */
function mediaRoot() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'meeting-minutes-media')
}

/** 只保留安全字符，避免路径穿越。 */
function safeMediaName(name, fallback) {
  const text = String(name ?? '').trim()
  const base = text === '' ? fallback : text
  return base.replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 120)
}

/** 二进制响应（图片等）。 */
function sendBinary(res, status, bytes, mime) {
  res.writeHead(status, {
    'content-type': mime,
    'cache-control': 'no-store',
    'content-length': bytes.length,
  })
  res.end(bytes)
}

/**
 * 按文件头识别图片格式。**不信任扩展名**——用户把 JPEG 存成 .png、
 * 或系统给出的名字不规范时，也能正确显示（这正是「PNG 提示格式不对」的常见原因）。
 * @param bytes - Buffer。
 * @returns `{ mime, ext }` 或 null。
 */
export function detectImageType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) return null
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mime: 'image/png', ext: 'png' }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' }
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' }
  }
  const head6 = bytes.length >= 6 ? bytes.toString('ascii', 0, 6) : ''
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return { mime: 'image/gif', ext: 'gif' }
  const head = bytes.toString('utf8', 0, Math.min(400, bytes.length)).trimStart().toLowerCase()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return { mime: 'image/svg+xml', ext: 'svg' }
  }
  return null
}

/** 缓存 ffmpeg 路径：PATH 里优先，其次 winget / 常见安装目录。 */
let ffmpegPathCache = null
let ffmpegProbed = false

function findFfmpeg() {
  if (ffmpegProbed) return ffmpegPathCache
  ffmpegProbed = true
  const candidates = []
  if (process.env.FFMPEG_PATH !== undefined && process.env.FFMPEG_PATH !== '') candidates.push(process.env.FFMPEG_PATH)
  const home = process.env.LOCALAPPDATA ?? ""
  candidates.push('ffmpeg')
  if (home !== "") {
    candidates.push(join(home, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'))
    const packages = join(home, 'Microsoft', 'WinGet', 'Packages')
    try {
      for (const name of readdirSync(packages)) {
        if (!String(name).toLowerCase().includes('ffmpeg')) continue
        const bin = join(packages, name)
        // 包目录形如 .../Gyan.FFmpeg_xxx/ffmpeg-9.0.2-full_build/bin/ffmpeg.exe
        const stack = [bin]
        while (stack.length > 0) {
          const current = stack.pop()
          let entries = []
          try { entries = readdirSync(current, { withFileTypes: true }) } catch { continue }
          for (const entry of entries) {
            const full = join(current, entry.name)
            if (entry.isFile() && entry.name.toLowerCase() === 'ffmpeg.exe') { candidates.push(full); break }
            if (entry.isDirectory() && current.split(sep).length < bin.split(sep).length + 4) stack.push(full)
          }
        }
      }
    } catch { }
  }
  candidates.push('C:/ffmpeg/bin/ffmpeg.exe', 'C:/Program Files/ffmpeg/bin/ffmpeg.exe')
  for (const candidate of candidates) {
    try {
      if (candidate !== "ffmpeg" && !existsSync(candidate)) continue
      ffmpegPathCache = candidate
      return candidate
    } catch { }
  }
  ffmpegPathCache = null
  return null
}

/** 把 WebM 转成 MP4（H.264 + AAC），成功返回 MP4 路径。 */
function transcodeToMp4(sourcePath, targetPath) {
  const ffmpeg = findFfmpeg()
  if (ffmpeg === null) return Promise.reject(new Error("没有找到 ffmpeg，无法转 MP4"))
  const args = [
    '-y', '-loglevel', 'error',
    '-i', sourcePath,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    targetPath,
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => { if (code === 0) resolve(targetPath); else reject(new Error('ffmpeg 退出码 ' + String(code))) })
  })
}

/** 在资源管理器里选中该文件（失败不影响主流程）。 */
function revealMediaPath(target) {
  try {
    if (process.platform === 'win32') {
      spawn('explorer.exe', ['/select,', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', ['-R', target], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [dirname(target)], { detached: true, stdio: 'ignore' }).unref()
    }
    return true
  } catch {
    return false
  }
}

/** 用系统默认关联程序打开文件（Windows 走 start，macOS 走 open，Linux 走 xdg-open）。 */
function openMediaPath(target) {
  if (process.env.DSH_MEETING_NO_OPEN === '1') return true
  try {
    if (!existsSync(target)) return false
    if (process.platform === 'win32') {
      // start 的第一个引号参数是窗口标题位，必须留空，否则带引号的路径会被当成标题。
      spawn('cmd.exe', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref()
    }
    return true
  } catch {
    return false
  }
}

/** Read a raw binary body (bounded). */
async function readRawBody(req, limit = 16 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error(`音频片段过大（超过 ${Math.round(limit / 1024 / 1024)}MB），请缩短切片长度。`)
    chunks.push(chunk)
  }
  // 必须返回 Buffer：本地 Paraformer 引擎（decodeWavToSamples）用 Buffer.isBuffer 判定，
  // 之前返回 new Uint8Array(...) 会让每个 5 秒分片都报「音频数据无效」，整场录音被打断。
  return Buffer.concat(chunks)
}

/**
 * 录音结束后会整段重跑「说话人分离 + 逐段识别」，但安静/远场录音上它可能只认出
 * 寥寥几句。**不能**用它直接覆盖已有的流式转写：实测一场 18 分钟会议被 2 行（19 字）
 * 覆盖掉 174 段已识别内容。只有新结果不显著短于旧转写时才替换。
 */
export function shouldUseDiarizedTranscript(currentText, analyzedText) {
  const current = String(currentText ?? '').trim()
  const next = String(analyzedText ?? '').trim()
  if (next === '') return false
  if (current === '') return true
  const currentChars = current.replace(/\s+/g, '').length
  const nextChars = next.replace(/\s+/g, '').length
  return nextChars >= Math.max(80, Math.round(currentChars * 0.7))
}

/** Only the loopback interface may reach these routes. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/* ── 整段重转写（把整场录音按 30 秒切片重新识别，修复 5 秒分片的碎片/漏字） ── */
const RETRANSCRIBE_SLICE_SECONDS = 30
/** 进行中的整段重转写任务：meetingId → { status, done, total, chars, error, note } */
const retranscribeJobs = new Map()

/** 按帧数切出整段重转写的分片范围（最后一片可能不足 30 秒）。 */
export function planRetranscribeSlices(totalFrames, sampleRate = 16000, sliceSeconds = RETRANSCRIBE_SLICE_SECONDS) {
  const frames = Math.max(0, Math.floor(Number(totalFrames) || 0))
  const rate = Number(sampleRate) > 0 ? Number(sampleRate) : 16000
  const step = Math.max(1, Math.round(rate * (Number(sliceSeconds) > 0 ? Number(sliceSeconds) : RETRANSCRIBE_SLICE_SECONDS)))
  const slices = []
  for (let start = 0; start < frames; start += step) {
    slices.push({ startFrame: start, endFrame: Math.min(frames, start + step), at: Math.round(start / rate) })
  }
  return slices
}

/** 把各分片文本合并成整段转写（丢弃空片，一行一片）。 */
export function mergeRetranscribeTexts(texts) {
  const lines = []
  for (const raw of Array.isArray(texts) ? texts : []) {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim()
    if (text !== '') lines.push(text)
  }
  return lines.join('\n')
}

/** Float32（[-1,1]，16k 单声道）→ PCM16 WAV Buffer。 */
function encodePcm16Wav(samples, sampleRate = 16000) {
  const data = Buffer.alloc(samples.length * 2)
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, Number(samples[index]) || 0))
    data.writeInt16LE(Math.round(value < 0 ? value * 0x8000 : value * 0x7fff), index * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** 用 ffmpeg 做音频预处理（音量归一化 + 高通滤波），输出 16k 单声道 WAV；失败返回 null。 */
async function preprocessAudioWithFfmpeg(inputPath, logger) {
  const ffmpeg = findFfmpeg()
  if (ffmpeg === null) return null
  const outPath = join(tmpdir(), 'dsh-preprocess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.wav')
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', inputPath,
        '-af', 'highpass=f=80,dynaudnorm=f=250:g=15',
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outPath,
      ], { windowsHide: true, stdio: 'ignore' })
      child.once('error', reject)
      child.once('exit', (code) => { if (code === 0) resolve(); else reject(new Error('ffmpeg 退出码 ' + String(code))) })
    })
    return outPath
  } catch (error) {
    await rm(outPath, { force: true }).catch(() => {})
    logger?.warn?.('meeting-minutes: audio preprocess failed: ' + String(error instanceof Error ? error.message : error))
    return null
  }
}

/** 后台跑完一整场录音的重转写：逐片识别，再决定是否替换现有转写。 */
async function runRetranscribeJob({ deps, store, meetingId, audioPath, logger }) {
  const job = retranscribeJobs.get(meetingId)
  if (job === undefined) return
  let preprocessedPath = null
  try {
    // 音频预处理（可选）：音量归一化 + 高通滤波，改善远场/小声录音
    let sourcePath = audioPath
    if (store.settings.preprocessAudio === true) {
      preprocessedPath = await preprocessAudioWithFfmpeg(audioPath, logger)
      if (preprocessedPath !== null) sourcePath = preprocessedPath
    }
    const bytes = await readFile(sourcePath)
    const decoded = deps.paraformer.decodeWavToSamples(bytes)
    const rate = Number(decoded?.sampleRate) > 0 ? Number(decoded.sampleRate) : 16000
    const samples = decoded?.samples ?? new Float32Array(0)
    const slices = planRetranscribeSlices(samples.length, rate)
    job.total = slices.length
    const rows = []
    for (const slice of slices) {
      const wav = encodePcm16Wav(samples.subarray(slice.startFrame, slice.endFrame), rate)
      let text = ''
      try {
        const result = await deps.paraformer.transcribeWav(wav)
        text = typeof result?.text === 'string' ? result.text.trim() : ''
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const benign = message === '语音识别没有识别出任何文字'
        if (!benign) logger?.warn?.(`meeting-minutes: retranscribe slice failed: ${message}`)
      }
      if (text !== '') rows.push({ at: slice.at, text })
      job.done += 1
    }
    const merged = mergeRetranscribeTexts(rows.map((row) => row.text))
    const mergedChars = merged.replace(/\s+/g, '').length
    const current = store.get(meetingId)
    const currentChars = String(current?.transcript ?? '').replace(/\s+/g, '').length
    if (mergedChars === 0) {
      job.status = 'error'
      job.error = '整段重转写没有识别出文字，已保留原转写'
      return
    }
    // 整段重转写是为了更连贯，但也不能把长转写换成一小段；明显变短时保留原转写。
    if (currentChars > 0 && mergedChars < Math.max(80, Math.round(currentChars * 0.6))) {
      job.status = 'done'
      job.chars = mergedChars
      job.note = '新识别内容偏少，已保留原转写'
      logger?.warn?.(`meeting-minutes: retranscribe result too short (${mergedChars} vs ${currentChars} chars); keeping the existing transcript`)
      return
    }
    await store.patch(meetingId, {
      transcript: merged,
      transcriptSegments: rows.map((row) => ({ speaker: '', text: row.text, at: row.at })),
      transcriptSeconds: Math.round(samples.length / rate),
    })
    job.status = 'done'
    job.chars = mergedChars
    job.note = null
    logger?.info?.(`meeting-minutes: retranscribe done (${mergedChars} chars, ${job.done} slices)`)
  } catch (error) {
    job.status = 'error'
    job.error = error instanceof Error ? error.message : String(error)
    logger?.warn?.(`meeting-minutes: retranscribe failed: ${job.error}`)
  } finally {
    if (preprocessedPath !== null) await rm(preprocessedPath, { force: true }).catch(() => {})
  }
}

/** Build the `/state` payload the panel renders. */
export async function buildState(deps) {
  const { store, asr, summarizer, calendar, autoIngest } = deps
  await store.load()
  const [speech, calendarStatus] = await Promise.all([
    Promise.resolve().then(() => asr.status()),
        deps.dshTodo !== undefined ? deps.dshTodo.describe(calendar) : calendar.status(),
  ])
  const settingsNow = store.settings
  const transcribeProvider = settingsNow.transcribe.provider
  const transcribeReady = transcribeProvider === 'paraformer-local'
    ? (deps.paraformer !== undefined && deps.paraformer !== null && deps.paraformer.available() === true)
    : (transcribeProvider.startsWith('cloud-') ? true : speech.available === true)
  const diarizationReady = deps.paraformer !== undefined && deps.paraformer !== null
    ? deps.paraformer.diarizationAvailable()
    : false
  const meetings = sortMeetings(store.snapshot().meetings).map((meeting) => projectMeeting(meeting))
  const auto = autoIngest?.status?.() ?? null
  const totals = meetings.reduce((acc, meeting) => {
    acc.meetings += 1
    acc.todos += meeting.todoCount
    acc.pendingTodos += meeting.pendingTodoCount
    acc.summarized += meeting.hasSummary ? 1 : 0
    return acc
  }, { meetings: 0, todos: 0, pendingTodos: 0, summarized: 0 })
  return {
    ok: true,
    now: new Date().toISOString(),
    today: localDay(),
    clock: formatMoment(),
    version: CURRENT_VERSION,
    autoIngest: auto,
    config: {
      llm: summarizer.describeRoute(store.summaryModel),
      asr: {
        mode: speech.available ? 'local' : 'unavailable',
        providerId: speech.selection?.providerId ?? null,
        language: speech.selection?.language ?? 'zh',
      },
    },
    speech,
    transcribe: {
      provider: transcribeProvider,
      ready: transcribeReady === true,
      diarizationReady: diarizationReady === true,
      correctTranscript: settingsNow.correctTranscript === true,
    },
    // 宿主能否找到 ffmpeg：录屏 / 非 WAV 音视频转码依赖它，首次引导据此提示安装
    screen: {
      ffmpegReady: findFfmpeg() !== null,
      platform: process.platform,
    },
    calendar: calendarStatus,
    totals,
    meetings,
    storeFile: store.file,
  }
}

/** Resolve one meeting id from route segments, or throw a 404-shaped error. */
function requireMeeting(store, id) {
  const meeting = store.get(id)
  if (meeting === null) {
    const error = new Error(`未找到会议：${id}`)
    error.status = 404
    throw error
  }
  return meeting
}

/**
 * Register the plugin's routes.
 * @param ctx - Cordis context carrying `webServer`.
 * @param deps - `store`, `asr`, `summarizer`, `calendar`, `autoIngest`, `logger`.
 * @returns a disposer removing the route.
 */
export function registerRoutes(ctx, deps) {
  const { store, asr, summarizer, calendar, autoIngest, logger } = deps

    /** 后台把刚上传的 WebM 转成 MP4，成功后替换媒体条目并删掉 WebM。 */
    async function convertMeetingVideo(meetingId, sourcePath, sourceName, seconds) {
      const targetName = String(sourceName).replace(/\.webm$/i, "") + ".mp4"
      const targetPath = join(dirname(sourcePath), targetName)
      try {
        await transcodeToMp4(sourcePath, targetPath)
        const info = await stat(targetPath)
        const current = store.get(meetingId)
        if (current !== null) {
          const previous = Array.isArray(current.media) ? current.media : []
          const entry = {
            kind: "video",
            name: targetName,
            path: targetPath,
            bytes: info.size,
            seconds: Math.round(seconds || 0),
            savedAt: new Date().toISOString(),
            converted: true,
          }
          await store.patch(meetingId, { media: [...previous.filter((item) => item.kind !== "video"), entry] })
        }
        try { await rm(sourcePath, { force: true }) } catch { }
        logger?.info?.(`meeting-minutes: 录屏已转 MP4 (${targetName})`)
      } catch (error) {
        logger?.warn?.(`meeting-minutes: 录屏转 MP4 失败：${String(error?.message ?? error)}`)
        try {
          const current = store.get(meetingId)
          if (current !== null) {
            const media = (Array.isArray(current.media) ? current.media : []).map((item) => item.kind === "video"
              ? { ...item, converting: false, convertError: String(error?.message ?? error) }
              : item)
            await store.patch(meetingId, { media })
          }
        } catch { }
      }
    }

  const handler = async (req, res) => {
    try {
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      const rest = path.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
      const segments = rest === '' ? [] : rest.split('/').map((segment) => decodeURIComponent(segment))
      const method = req.method ?? 'GET'
      await store.load()

      if (segments.length === 1 && segments[0] === 'health') {
        sendJson(res, 200, { ok: true, plugin: 'dsh-meeting-live', file: store.file })
        return
      }

      if (segments.length === 1 && segments[0] === 'state' && method === 'GET') {
        sendJson(res, 200, await buildState(deps))
        return
      }

      // 检查更新：只查询最新版本并返回下载页，不下载/不安装（设置页「检查更新」用）
      if (segments.length === 1 && segments[0] === 'update-check' && method === 'GET') {
        const force = url.searchParams.get('force') === '1'
        sendJson(res, 200, await checkForUpdate({ force }))
        return
      }

      // 插件内置示意图：只允许 resources/ 下的简单文件名，避免路径穿越。
      if (segments.length === 2 && segments[0] === 'assets' && method === 'GET') {
        const name = segments[1]
        if (!/^[a-z0-9][a-z0-9-]*\.(png|jpg|jpeg|webp|gif|svg)$/i.test(name)) {
          sendJson(res, 400, { ok: false, error: '图片名不合法' })
          return
        }
        const file = join(RESOURCES_DIR, name)
        if (!existsSync(file)) {
          sendJson(res, 404, { ok: false, error: `图片不存在：${name}` })
          return
        }
        const bytes = await readFile(file)
        const type = detectImageType(bytes)
        if (type === null) {
          sendJson(res, 415, { ok: false, error: '图片格式无法识别' })
          return
        }
        sendBinary(res, 200, bytes, type.mime)
        return
      }

      if (segments.length === 2 && segments[0] === 'speech' && segments[1] === 'status' && method === 'GET') {
        sendJson(res, 200, { ok: true, speech: asr.status() })
        return
      }

      if (segments.length === 2 && segments[0] === 'speech' && segments[1] === 'prepare' && method === 'POST') {
        const body = await readJsonBody(req)
        asr.prepare(body.providerId)
        sendJson(res, 200, { ok: true, speech: asr.status() })
        return
      }

      if (segments.length === 2 && segments[0] === 'dialog' && segments[1] === 'pick-dir' && method === 'POST') {
        const body = await readJsonBody(req)
        const picked = await pickFolder(typeof body?.title === 'string' ? body.title : '')
        sendJson(res, 200, { ok: true, path: picked })
        return
      }

      if (segments.length === 2 && segments[0] === 'auto-ingest' && segments[1] === 'status' && method === 'GET') {
        sendJson(res, 200, { ok: true, autoIngest: autoIngest === undefined ? null : autoIngest.status() })
        return
      }

      if (segments.length === 2 && segments[0] === 'auto-ingest' && segments[1] === 'scan' && method === 'POST') {
        if (autoIngest === undefined) throw new Error('自动识别不可用')
        void autoIngest.scanNow().catch((error) => logger?.warn?.(error))
        sendJson(res, 200, { ok: true, autoIngest: autoIngest.status() })
        return
      }

      if (segments.length === 1 && segments[0] === 'auto-ingest' && method === 'POST') {
        if (autoIngest === undefined) throw new Error('自动识别不可用')
        const body = await readJsonBody(req)
        const autoIngestStatus = await autoIngest.setConfig({
          ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
          ...(body.tencent === undefined ? {} : { tencent: body.tencent }),
          ...(body.tencentDir === undefined ? {} : { tencentDir: body.tencentDir }),
          ...(body.dirsEnabled === undefined ? {} : { dirsEnabled: body.dirsEnabled }),
          ...(Array.isArray(body.dirs) ? { dirs: body.dirs } : {}),
        })
        sendJson(res, 200, { ok: true, autoIngest: autoIngestStatus })
        return
      }

      if (segments.length === 2 && segments[0] === 'live' && segments[1] === 'status' && method === 'POST') {
        // 浏览器录音时每秒一次的心跳：上报录音状态，顺带取走浮窗下发的指令
        // （pause / resume / stop）。没有镜像时按空指令答复，不影响录音。
        const body = await readJsonBody(req)
        const mirror = deps.liveMirror
        if (mirror !== undefined && mirror !== null) mirror.setStatus(body ?? {})
        sendJson(res, 200, {
          ok: true,
          command: mirror?.takeCommand?.() ?? null,
          // 浏览器据此决定是否隐藏页面底部那条录音条（浮窗接管时就不重复显示）。
          orb: deps.orb?.running === true,
        })
        return
      }

      if (segments.length === 1 && segments[0] === 'settings' && method === 'GET') {
        const llm = deps.ctx?.get?.('llm')
        const models = []
        if (llm !== undefined && llm !== null && typeof llm.listProviders === 'function') {
          for (const provider of llm.listProviders()) {
            const providerId = String(provider?.id ?? provider?.provider ?? '')
            if (providerId === '') continue
            try {
              const list = await llm.listModels(providerId)
              for (const item of Array.isArray(list) ? list : []) {
                models.push({
                  provider: providerId,
                  id: String(item.id ?? ''),
                  name: String(item.name ?? item.id ?? ''),
                  displayName: String(provider?.displayName ?? providerId),
                })
              }
            } catch (error) {
              // 有的适配器不提供模型目录；忽略该 provider，不影响其它模型
              logger?.debug?.('meeting-minutes: listModels failed for ' + providerId + ': ' + String(error?.message ?? error))
            }
          }
        }
        let defaultModel = null
        try {
          const selection = deps.ctx?.get?.('agentDefaultModel')?.currentSelection?.()
          if (selection !== null && selection !== undefined) {
            defaultModel = { provider: String(selection.provider ?? ''), model: String(selection.model ?? '') }
          }
        } catch {
          defaultModel = null
        }
        const settings = store.settings
        const modelsState = deps.modelManager !== undefined && deps.modelManager !== null
          ? deps.modelManager.status()
          : null
        const paraformerReady = deps.paraformer !== undefined && deps.paraformer !== null
          ? deps.paraformer.available()
          : false
        const diarizationReady = deps.paraformer !== undefined && deps.paraformer !== null
          ? deps.paraformer.diarizationAvailable()
          : false
        sendJson(res, 200, {
          ok: true,
          version: CURRENT_VERSION,
          model: store.summaryModel,
          defaultModel,
          models: models.filter((item) => item.id !== ''),
          settings,
          transcribeProviders: TRANSCRIBE_PROVIDERS,
          cloudProviders: CLOUD_PROVIDERS,
          modelsState,
          paraformerReady,
          diarizationReady,
        })
        return
      }

      if (segments.length === 1 && segments[0] === 'settings' && (method === 'PATCH' || method === 'POST')) {
        const body = await readJsonBody(req)
        const warnings = []
        if (body.model !== undefined) {
          await store.setSummaryModel(body.model)
        }
        if (body.settings !== undefined) {
          const incoming = body.settings !== null && typeof body.settings === 'object' ? body.settings : {}
          const current = store.settings
          const merged = {
            ...current,
            ...incoming,
            transcribe: {
              ...current.transcribe,
              ...(incoming.transcribe ?? {}),
              cloud: { ...current.transcribe.cloud, ...(incoming.transcribe?.cloud ?? {}) },
            },
            summary: {
              ...current.summary,
              ...(incoming.summary ?? {}),
              custom: { ...current.summary.custom, ...(incoming.summary?.custom ?? {}) },
            },
          }
          // 配置不完整不阻止保存：先让用户能切模式/填一半，真正用到时再给明确错误
          if (merged.transcribe?.provider?.startsWith('cloud-') === true) {
            const cloudError = validateCloudSettings(merged.transcribe.provider, merged.transcribe.cloud)
            if (cloudError !== null) warnings.push(cloudError)
          }
          if (merged.summary?.mode === 'custom') {
            const summaryError = validateSummaryCustom(merged.summary.custom)
            if (summaryError !== null) warnings.push(summaryError)
          }
          await store.setSettings(merged)
        }
        sendJson(res, 200, {
          ok: true,
          model: store.summaryModel,
          settings: store.settings,
          terms: effectiveTerms(store.settings),
          warnings,
        })
        return
      }

      // 从文件夹解析术语：扫描文本/Word/Excel/PDF → 请总结模型排序 → 返回预览（由前端勾选后保存）。
      if (segments.length === 2 && segments[0] === 'terms' && segments[1] === 'extract' && method === 'POST') {
        const body = await readJsonBody(req)
        const dirsInput = Array.isArray(body?.dirs) ? body.dirs : (typeof body?.dir === 'string' ? [body.dir] : [])
        const dirs = [...new Set(dirsInput.map((item) => String(item ?? '').trim()).filter((item) => item !== ''))]
        if (dirs.length === 0) throw new Error('请先选择要解析的文件夹')
        const scanned = await scanFolders(dirs)
        if (scanned.text === '') {
          throw new Error('这些文件夹里没有可解析的文本、Word、Excel 或 PDF 文本（支持 .txt / .md / .json / .csv / .log / .html / .docx / .xlsx / .pdf）')
        }
        const settingsNow = store.settings
        const result = await summarizer.extractTerms(scanned.text, { ...scanned.stats, names: scanned.names }, {
          selection: store.summaryModel,
          custom: settingsNow.summary.mode === 'custom' ? settingsNow.summary.custom : null,
        })
        const items = normalizeTermItems(result.items)
        logger?.info?.('meeting-minutes: term preview with ' + String(items.length) + ' item(s) from ' + String(dirs.length) + ' folder(s)')
        sendJson(res, 200, {
          ok: true,
          preview: {
            dirs,
            at: new Date().toISOString(),
            items,
            stats: scanned.stats,
          },
        })
        return
      }

      if (segments.length === 2 && segments[0] === 'settings' && segments[1] === 'cloud-test' && method === 'POST') {
        const body = await readJsonBody(req)
        const provider = String(body.provider ?? '')
        const cloud = body.cloud ?? store.settings.transcribe.cloud
        const cloudError = validateCloudSettings(provider, cloud)
        if (cloudError !== null) throw new Error(cloudError)
        sendJson(res, 200, {
          ok: true,
          message: '配置格式校验通过；真实连通性会在录音转写时验证（当前未发起网络请求）',
        })
        return
      }

      if (segments.length === 2 && segments[0] === 'settings' && segments[1] === 'summary-test' && method === 'POST') {
        const body = await readJsonBody(req)
        const settingsNow = store.settings
        const custom = body?.custom ?? (settingsNow.summary.mode === 'custom' ? settingsNow.summary.custom : null)
        if (custom === null || custom === undefined) {
          const route = summarizer.describeRoute(store.summaryModel)
          sendJson(res, 200, { ok: true, message: '当前使用 DSH 模型：' + String(route.model ?? '未配置') })
          return
        }
        const customError = validateSummaryCustom(custom)
        if (customError !== null) throw new Error(customError)
        const started = Date.now()
        const url = String(custom.baseUrl).replace(/\/+$/, '') + '/chat/completions'
        let payload
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(custom.apiKey === '' ? {} : { authorization: 'Bearer ' + custom.apiKey }),
            },
            body: JSON.stringify({
              model: custom.model,
              messages: [{ role: 'user', content: '回复"ok"两个字即可' }],
              max_tokens: 16,
              stream: false,
            }),
          })
          payload = await response.json().catch(() => null)
          if (!response.ok) {
            const message = payload?.error?.message ?? payload?.message ?? ''
            throw new Error('接口返回 ' + String(response.status) + (message === '' ? '' : '：' + String(message)))
          }
        } catch (networkError) {
          throw new Error('连不上接口：' + (networkError instanceof Error ? networkError.message : String(networkError)))
        }
        const sample = String(payload?.choices?.[0]?.message?.content ?? '').slice(0, 40)
        sendJson(res, 200, {
          ok: true,
          message: '接口可用（' + String(Date.now() - started) + 'ms）' + (sample === '' ? '' : '，返回：' + sample),
        })
        return
      }

      if (segments.length >= 2 && segments[0] === 'models') {
        const manager = deps.modelManager
        if (manager === undefined || manager === null) throw new Error('模型管理不可用')
        if (segments.length === 2 && segments[1] === 'status' && method === 'GET') {
          sendJson(res, 200, { ok: true, state: manager.status() })
          return
        }
        if (segments.length === 3 && segments[2] === 'download' && method === 'POST') {
          const kind = String(segments[1])
          // 大模型下载耗时几分钟：立刻返回，进度由 GET /models/status 轮询。
          void manager.download(kind).then((result) => {
            if (result.ok !== true) logger?.warn?.('meeting-minutes: model download failed: ' + String(result.error ?? ''))
          }).catch((error) => {
            logger?.warn?.('meeting-minutes: model download crashed: ' + (error instanceof Error ? error.message : String(error)))
          })
          sendJson(res, 200, { ok: true, started: true, state: manager.status() })
          return
        }
        if (segments.length === 2 && method === 'DELETE') {
          const kind = String(segments[1])
          const result = await manager.remove(kind)
          if (result.ok !== true) throw new Error(result.error ?? '删除失败')
          sendJson(res, 200, { ok: true, state: manager.status() })
          return
        }
      }

      if (segments.length === 2 && segments[0] === 'screen' && segments[1] === 'identify' && method === 'POST') {
        const body = await readJsonBody(req)
        const identified = await identifyScreen(String(body.source ?? 'desktop'), logger)
        sendJson(res, identified.ok === true ? 200 : 400, {
          ok: identified.ok === true,
          label: identified.label ?? null,
          bounds: identified.bounds ?? null,
          error: identified.error ?? null,
        })
        return
      }

      if (segments.length === 2 && segments[0] === 'screen' && segments[1] === 'sources' && method === 'GET') {
        const sources = await listScreenSources()
        sendJson(res, 200, { ok: true, sources })
        return
      }

      if (segments.length === 1 && segments[0] === 'digest' && method === 'POST') {
        const body = await readJsonBody(req)
        const days = Math.max(1, Math.min(90, Math.round(Number(body.days) || 7)))
        const since = new Date(Date.now() - days * 24 * 3600 * 1000)
        const sinceDay = localDay(since)
        const meetings = store.snapshot().meetings
          .filter((item) => String(item.date ?? '') >= sinceDay || (item.updatedAt !== undefined && new Date(item.updatedAt) >= since))
          .sort((left, right) => String(right.date ?? '').localeCompare(String(left.date ?? '')))
          .slice(0, 30)
        if (meetings.length === 0) throw new Error('所选时间范围内没有可汇总的会议')
        const settingsNow = store.settings
        const digest = await summarizer.generateDigest(meetings, {
          selection: store.summaryModel,
          custom: settingsNow.summary.mode === 'custom' ? settingsNow.summary.custom : null,
          rangeLabel: '近 ' + String(days) + ' 天（' + sinceDay + ' 至今）',
        })
        sendJson(res, 200, { ok: true, markdown: digest.markdown, count: digest.count, days, rangeLabel: sinceDay })
        return
      }

      if (segments.length === 1 && segments[0] === 'search' && method === 'GET') {
        const query = String(url.searchParams.get('q') ?? '').trim()
        const limit = Math.max(1, Math.min(50, Math.round(Number(url.searchParams.get('limit')) || 20)))
        if (query === '') {
          sendJson(res, 200, { ok: true, results: [] })
          return
        }
        const needles = query.toLowerCase().split(/\s+/).filter((item) => item !== '')
        const results = []
        for (const meeting of store.snapshot().meetings) {
          const summary = meeting.summary ?? {}
          const summaryText = [
            summary.oneLine,
            summary.overview,
            ...(Array.isArray(summary.keyPoints) ? summary.keyPoints : []),
            ...(Array.isArray(summary.decisions) ? summary.decisions.map((item) => (typeof item === 'string' ? item : item?.text)) : []),
            ...(Array.isArray(summary.risks) ? summary.risks.map((item) => (typeof item === 'string' ? item : item?.text)) : []),
            ...(Array.isArray(summary.todos) ? summary.todos.map((item) => item?.title) : []),
          ].filter(Boolean).join('\n')
          const sections = [
            { key: 'title', text: String(meeting.title ?? '') },
            { key: 'attendees', text: (Array.isArray(meeting.attendees) ? meeting.attendees : []).join('、') },
            { key: 'transcript', text: String(meeting.transcript ?? '') },
            { key: 'summary', text: summaryText },
          ]
          let score = 0
          let snippet = ''
          let matchedAll = true
          for (const needle of needles) {
            let found = 0
            for (const section of sections) {
              const haystack = section.text.toLowerCase()
              let index = haystack.indexOf(needle)
              while (index >= 0) {
                found += 1
                if (snippet === '') {
                  const start = Math.max(0, index - 40)
                  snippet = section.text.slice(start, Math.min(section.text.length, index + needle.length + 80)).trim()
                }
                index = haystack.indexOf(needle, index + needle.length)
              }
              if (section.key === 'title' && haystack.includes(needle)) score += 20
              if (section.key === 'summary') score += 2
            }
            if (found === 0) { matchedAll = false; break }
            score += Math.min(20, found)
          }
          if (!matchedAll) continue
          results.push({
            id: meeting.id,
            title: String(meeting.title ?? '未命名会议'),
            date: String(meeting.date ?? ''),
            sourceType: meeting.sourceType,
            hasSummary: summary.oneLine !== undefined && summary.oneLine !== '',
            snippet,
            score,
          })
        }
        results.sort((left, right) => right.score - left.score || right.date.localeCompare(left.date))
        sendJson(res, 200, { ok: true, results: results.slice(0, limit), total: results.length })
        return
      }

      if (segments.length === 1 && segments[0] === 'meetings' && method === 'POST') {
        const body = await readJsonBody(req)
        const meeting = await store.add({
          title: body.title,
          date: body.date,
          attendees: body.attendees,
          sourceType: body.sourceType,
          transcript: body.transcript,
          notes: body.notes,
        })
        sendJson(res, 200, { ok: true, meeting })
        return
      }

      if (segments[0] !== 'meetings' || segments.length < 2) {
        sendJson(res, 404, { ok: false, error: `未知接口：${method} ${path}` })
        return
      }

      const id = segments[1]

      if (segments.length === 4 && segments[2] === 'screen' && segments[3] === 'start' && method === 'POST') {
        requireMeeting(store, id)
        const body = await readJsonBody(req)
        const started = await startScreenCapture({ meetingId: id, source: String(body.source ?? 'desktop'), logger })
        sendJson(res, started.ok === true ? 200 : 400, {
          ok: started.ok === true,
          label: started.label ?? null,
          error: started.error ?? null,
        })
        return
      }

      if (segments.length === 4 && segments[2] === 'screen' && segments[3] === 'stop' && method === 'POST') {
        const stopped = await stopScreenCapture(id, logger)
        sendJson(res, stopped.ok === true ? 200 : 400, {
          ok: stopped.ok === true,
          seconds: stopped.seconds ?? 0,
          error: stopped.error ?? null,
        })
        return
      }

      if (segments.length === 4 && segments[2] === 'correction' && segments[3] === 'apply' && method === 'POST') {
        const meeting = requireMeeting(store, id)
        const correction = meeting.correction
        if (correction === null || correction === undefined) throw new Error('当前没有待确认的转写纠错')
        const body = await readJsonBody(req)
        const accepted = Array.isArray(body.accepted)
          ? body.accepted.map((value) => Number(value)).filter((value) => Number.isInteger(value))
          : correction.changes.map((item, index) => index)
        const transcript = applyCorrectionChanges(correction.original, correction.changes, accepted)
        const updated = await store.patch(id, { transcript, correction: null })
        logger?.info?.('meeting-minutes: applied ' + String(accepted.length) + ' correction(s)')
        sendJson(res, 200, { ok: true, meeting: updated, applied: accepted.length })
        return
      }

      if (segments.length === 4 && segments[2] === 'correction' && segments[3] === 'discard' && method === 'POST') {
        requireMeeting(store, id)
        const updated = await store.patch(id, { correction: null })
        sendJson(res, 200, { ok: true, meeting: updated })
        return
      }

      if (segments.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, { ok: true, meeting: requireMeeting(store, id) })
          return
        }
        if (method === 'PATCH' || method === 'POST') {
          requireMeeting(store, id)
          const body = await readJsonBody(req)
          const patch = {}
          for (const key of ['title', 'date', 'attendees', 'transcript', 'transcriptSegments', 'speakerNames', 'correction', 'notes', 'sourceType', 'transcriptSeconds', 'media']) {
            if (body[key] !== undefined) patch[key] = body[key]
          }
          if (body.appendTranscript === true) {
            const current = requireMeeting(store, id)
            patch.transcript = current.transcript === '' ? String(body.transcript ?? '') : `${current.transcript}\n${String(body.transcript ?? '')}`
          }
          if (Object.keys(patch).length === 0) throw new Error('没有提供任何要修改的字段')
          const updated = await store.patch(id, patch)
          sendJson(res, 200, { ok: true, meeting: updated })
          return
        }
        if (method === 'DELETE') {
          try { await stopScreenCapture(id, logger) } catch { }
          const pendingVideo = takePendingVideo(id)
          if (pendingVideo !== null) await dropTempVideo(pendingVideo.tmpPath)
          const removed = await store.remove(id)
          try { await rm(join(mediaRoot(), id), { recursive: true, force: true }) } catch { }
          sendJson(res, removed === null ? 404 : 200, removed === null ? { ok: false, error: '未找到会议' } : { ok: true })
          return
        }
      }

      if (segments.length === 3 && segments[2] === 'summarize' && method === 'POST') {
        const meeting = requireMeeting(store, id)
        const body = await readJsonBody(req)
        logger?.info?.(`meeting-minutes: summarizing ${id} (${meeting.transcript.length} chars)`)
        const settingsNow = store.settings
        const summary = await summarizer.summarize(meeting, {
          selection: store.summaryModel,
          template: settingsNow.summaryTemplate,
          custom: settingsNow.summary.mode === 'custom' ? settingsNow.summary.custom : null,
        })
        const patch = {}
        if (meeting.attendees.length === 0 && summary.attendees.length > 0) {
          patch.attendees = summary.attendees
        }
        // An automatic placeholder title ("录音纪要 10-21 17:30", "会议纪要 2026-10-21")
        // is exactly what the user did not have time to name. The summary model now
        // proposes a real title; adopt it unless the user explicitly opted out or
        // already typed a title of their own.
        let renamedTo = null
        if (body.autoTitle !== false
          && summary.suggestedTitle !== ''
          && summary.suggestedTitle !== meeting.title
          && isGenericTitle(meeting.title)) {
          patch.title = summary.suggestedTitle
          renamedTo = summary.suggestedTitle
        }
        if (Object.keys(patch).length > 0) await store.patch(id, patch)
        const updated = await store.setSummary(id, summary)
        sendJson(res, 200, { ok: true, meeting: updated, renamedTo })
        return
      }

      if (segments.length === 3 && segments[2] === 'transcribe' && method === 'POST') {
        requireMeeting(store, id)
        const language = url.searchParams.get('language') ?? undefined
        const providerId = url.searchParams.get('provider') ?? undefined
        const bytes = await readRawBody(req)
        if (bytes.length === 0) throw new Error('音频为空：没有收到可识别的数据。')
        const transcribeSettings = store.settings.transcribe
        const engine = transcribeSettings.provider
        let result
        try {
          if (engine === 'paraformer-local' && deps.paraformer !== undefined && deps.paraformer.available() === true) {
            result = await deps.paraformer.transcribeWav(bytes)
          } else if (engine.startsWith('cloud-') === true) {
            const cloudKey = engine.replace('cloud-', '')
            const cloudResult = await deps.cloudAsr.transcribeCloud({
              provider: cloudKey,
              config: transcribeSettings.cloud[cloudKey] ?? {},
              wavBuffer: bytes,
              // 术语表直接作为云端 ASR 热词（腾讯/阿里支持请求级热词；讯飞需控制台配置）
              hotwords: effectiveTerms(store.settings),
            })
            if (cloudResult.ok !== true) throw new Error(cloudResult.error ?? '云端语音识别失败')
            const audioSeconds = Math.max(0, (bytes.length - 44) / (16000 * 2))
            result = { text: cloudResult.text, audioSeconds: Math.round(audioSeconds * 100) / 100, inferenceSeconds: 0 }
          } else {
            result = await asr.transcribeWav(bytes, { language, providerId })
          }
        } catch (error) {
          // 实时转写是每 5 秒切一片滚动送识别的；某一片里没有可识别语音
          // （静音、环境噪声、说话太轻、刚点录音还没开口）属于正常现象，
          // 识别服务把它当致命错误会让整场录音当场中断，这里降级成空结果继续。
          // 另外个别分片可能因请求被中断、音频头不完整而解码失败，同理按空结果处理。
          const failureMessage = error instanceof Error ? error.message : String(error)
          const benignFailure = failureMessage === '语音识别没有识别出任何文字'
            || failureMessage === '音频数据无效'
            || failureMessage === '音频数据不是 WAV 格式'
            || failureMessage === '只支持 16bit PCM WAV'
            || failureMessage === '音频数据里没有找到 PCM 数据段'
          if (!benignFailure) {
            // 真故障写进宿主日志，便于事后定位（原插件在这里静默抛出）。
            logger?.warn?.(`meeting-minutes: transcribe failed: ${failureMessage}`)
            throw error
          }
          const audioSeconds = Math.max(0, (bytes.length - 44) / (16000 * 2))
          logger?.info?.(`meeting-minutes: chunk had no usable audio (${audioSeconds.toFixed(1)}s, ${failureMessage}); keeping the session`)
          result = { text: '', audioSeconds: Math.round(audioSeconds * 100) / 100, inferenceSeconds: 0 }
        }
        const updated = await store.appendTranscript(id, result.text, result.audioSeconds)
        sendJson(res, 200, {
          ok: true,
          text: result.text,
          audioSeconds: result.audioSeconds,
          inferenceSeconds: result.inferenceSeconds,
          transcript: updated?.transcript ?? '',
          transcriptSeconds: updated?.transcriptSeconds ?? 0,
        })
        return
      }

      // 整段重转写：POST 启动（异步），GET 查进度。用于修复实时 5 秒分片造成的碎片/漏字。
      if (segments.length === 3 && segments[2] === 'retranscribe' && (method === 'POST' || method === 'GET')) {
        const meeting = requireMeeting(store, id)
        if (method === 'GET') {
          const job = retranscribeJobs.get(id)
          sendJson(res, 200, { ok: true, job: job ? { ...job } : { status: 'idle', done: 0, total: 0 } })
          return
        }
        const audio = (Array.isArray(meeting.media) ? meeting.media : [])
          .find((item) => item && item.kind === 'audio' && typeof item.path === 'string' && existsSync(item.path))
        if (audio === undefined) throw new Error('这场会议没有可用的录音文件，无法整段重转写')
        if (deps.paraformer === undefined || deps.paraformer === null || typeof deps.paraformer.transcribeWav !== 'function'
          || deps.paraformer.available?.() !== true) {
          throw new Error('本地 Paraformer 模型未就绪，无法整段重转写')
        }
        const running = retranscribeJobs.get(id)
        if (running !== undefined && running.status === 'running') {
          sendJson(res, 200, { ok: true, job: { ...running } })
          return
        }
        const job = { status: 'running', done: 0, total: 0, chars: 0, error: null, note: null, startedAt: Date.now() }
        retranscribeJobs.set(id, job)
        sendJson(res, 200, { ok: true, job: { ...job } })
        void runRetranscribeJob({ deps, store, meetingId: id, audioPath: audio.path, logger })
        return
      }

      if (segments.length === 4 && segments[2] === 'todos' && method === 'PATCH') {
        const body = await readJsonBody(req)
        const updated = await store.patchTodo(id, segments[3], body)
        sendJson(res, 200, { ok: true, meeting: updated })
        return
      }

      if (segments.length === 4 && segments[2] === 'todos' && segments[3] === 'push' && method === 'POST') {
        const meeting = requireMeeting(store, id)
        const body = await readJsonBody(req)
        const todoIds = Array.isArray(body.todoIds) ? body.todoIds.map(String) : undefined
        let result = { created: [] }
        let failure = null
        const dshTodo = deps.dshTodo
        try {
          if (dshTodo === undefined || dshTodo === null) {
            throw new Error('DSH 待办不可用：请确认 dsh-memory-evolve 插件已启用')
          }
          await dshTodo.ready()
          if (dshTodo.status().available !== true) {
            throw new Error('DSH 待办不可用：未找到待办存储（~/.dsh/memories）')
          }
          const wanted = todoIds === undefined ? null : new Set(todoIds)
          const targets = (meeting.summary?.todos ?? []).filter((todo) => wanted === null || wanted.has(todo.id))
          for (const todo of targets) {
            const title = String(todo.title ?? '').trim()
            if (title === '') continue
            const owner = String(todo.owner ?? '').trim()
            const due = typeof todo.due === 'string' ? todo.due.trim() : ''
            const notes = String(todo.notes ?? '').trim()
            // 保持单行：DSH 待办卡片遇到多行会多渲染一段正文，样式和原来不一致。
            // 负责人/截止/备注用括号内联，信息不丢、外观不变。
            const extras = []
            if (owner !== '') extras.push(`负责人：${owner}`)
            if (due !== '') extras.push(`截止：${due}`)
            if (notes !== '') extras.push(`备注：${notes.length > 60 ? notes.slice(0, 60) + '…' : notes}`)
            const text = extras.length > 0 ? `${title}（${extras.join('；')}）` : title
            const added = dshTodo.add(text, {
              due: due !== '' ? due : undefined,
              quadrant: todo.priority === 'high' ? 'q1' : (todo.priority === 'low' ? 'q4' : 'q2'),
              cat: '会议纪要',
            })
            if (added.ok !== true) throw new Error(`写入待办失败：${added.message ?? '未知原因'}`)
            result.created.push({ todoId: todo.id, calendarTaskId: `dsh-todo:${added.id}`, title })
          }
        } catch (error) {
          failure = error
          result = { created: result.created }
        }
        for (const entry of result.created) {
          await store.markTodoPushed(id, entry.todoId, entry.calendarTaskId)
        }
        const updated = requireMeeting(store, id)
        const calendarStatus = dshTodo !== undefined && dshTodo !== null
          ? await dshTodo.describe(calendar, true)
          : await calendar.status(true)
        if (failure !== null) {
          sendJson(res, 400, {
            ok: false,
            error: failure.message,
            created: result.created,
            failed: failure.failed ?? [],
            meeting: updated,
            calendar: calendarStatus,
            progress: todoProgress(updated),
          })
          return
        }
        sendJson(res, 200, {
          ok: true,
          created: result.created,
          meeting: updated,
          calendar: calendarStatus,
          progress: todoProgress(updated),
        })
        return
      }

      // 只重新生成待办：保留已写入/已弃用的旧条目，只追加模型新识别出的行动项。
      if (segments.length === 4 && segments[2] === 'todos' && segments[3] === 'regenerate' && method === 'POST') {
        const meeting = requireMeeting(store, id)
        if (meeting.summary === null || meeting.summary === undefined) {
          throw new Error('这场会议还没有 AI 纪要，无法重新生成待办')
        }
        if (deps.summarizer === undefined || deps.summarizer === null || typeof deps.summarizer.extractTodos !== 'function') {
          throw new Error('总结模型不可用，无法重新生成待办')
        }
        const settings = store.settings
        const extracted = await deps.summarizer.extractTodos(meeting, {
          selection: store.summaryModel,
          custom: settings.summary.mode === 'custom' ? settings.summary.custom : null,
        })
        const existing = Array.isArray(meeting.summary.todos) ? meeting.summary.todos : []
        const keyOf = (todo) => `${String(todo?.title ?? '').trim()}\u0000${String(todo?.owner ?? '').trim()}`
        const seen = new Set(existing.map(keyOf))
        const merged = [...existing]
        let added = 0
        for (const todo of Array.isArray(extracted) ? extracted : []) {
          const key = keyOf(todo)
          if (key.trim() === '') continue
          if (seen.has(key)) continue
          seen.add(key)
          merged.push(todo)
          added += 1
        }
        const updated = added > 0
          ? await store.patch(id, { summary: { ...meeting.summary, todos: merged } })
          : meeting
        sendJson(res, 200, {
          ok: true,
          added,
          meeting: updated,
          todos: Array.isArray(updated.summary?.todos) ? updated.summary.todos : [],
        })
        return
      }

      if (segments.length === 4 && segments[2] === 'media' && segments[3] === 'upload' && method === 'POST') {
        const meeting = requireMeeting(store, id)
        const kind = url.searchParams.get('kind') === 'video' ? 'video' : 'audio'
        const fallback = kind === 'video' ? '会议录屏.webm' : '会议录音.wav'
        const fileName = safeMediaName(url.searchParams.get('name'), fallback)
        const seconds = Number(url.searchParams.get('seconds')) || 0
        const bytes = await readRawBody(req, 1024 * 1024 * 1024)
        if (bytes.length === 0) throw new Error('没有收到文件内容')
        const directory = join(mediaRoot(), id)
        await mkdir(directory, { recursive: true })
        const target = join(directory, fileName)
        await writeFile(target, bytes)
        const previous = Array.isArray(meeting.media) ? meeting.media : []
        const entry = {
          kind,
          name: fileName,
          path: target,
          bytes: bytes.length,
          seconds: Math.round(seconds),
          savedAt: new Date().toISOString(),
        }
        // 录屏由宿主 ffmpeg 采集成 mkv，等这段音频（WAV）上传后合成 MP4。
        let muxed = null
        if (kind === 'audio' && isCapturing(id) === false) {
          const pendingVideo = takePendingVideo(id)
          if (pendingVideo !== null) {
            const mp4Name = safeMediaName(fileName.replace(/\.wav$/i, '') + '.mp4', '会议录屏.mp4')
            const mp4Path = join(directory, mp4Name)
            const result = await muxScreenWithAudio({ videoPath: pendingVideo.tmpPath, audioPath: target, outPath: mp4Path, logger })
            await dropTempVideo(pendingVideo.tmpPath)
            if (result.ok === true) {
              muxed = {
                kind: 'video',
                name: mp4Name,
                path: mp4Path,
                bytes: result.bytes,
                seconds: Math.round(seconds),
                savedAt: new Date().toISOString(),
                converted: true,
              }
            } else {
              logger?.warn?.('meeting-minutes: 合成录屏视频失败：' + String(result.error ?? '未知原因'))
            }
          }
        }
        const stored = muxed === null ? entry : entry
        const kept = previous.filter((item) => item.kind !== kind && (muxed === null || item.kind !== 'video'))
        const media = [...kept, stored, ...(muxed === null ? [] : [muxed])]
        // 录音质量分析：整段 WAV 上传后算音量/削波/信噪比，存进会议并返回给界面提示
        let quality = null
        if (kind === 'audio') {
          const analyzed = analyzeWavQuality(bytes)
          if (analyzed !== null) {
            quality = { ...analyzed, analyzedAt: new Date().toISOString() }
            await store.patch(id, { audioQuality: quality })
          }
        }
        const updated = await store.patch(id, { media })
        sendJson(res, 200, { ok: true, media: (updated && updated.media) || media, entry: stored, quality })
        // 音频落盘后做两件后台事（不阻塞响应）：
        //  1) 若装了 Paraformer + pyannote + cam++，整段跑真说话人分离，替换启发式的 A/B/C/D；
        //  2) 若开启纠错，用 LLM 只改错别字/术语/人名。
        if (kind === 'audio') {
          void (async () => {
            try {
              const settingsNow = store.settings
              if (settingsNow.diarize === true && deps.paraformer !== undefined && deps.paraformer.diarizationAvailable() === true) {
                const analyzed = await deps.paraformer.transcribeFileWithSpeakers(target)
                const currentMeeting = store.get(id)
                const batchText = typeof analyzed.text === 'string' ? analyzed.text : ''
                const useBatch = shouldUseDiarizedTranscript(currentMeeting?.transcript, batchText)
                if (useBatch && Array.isArray(analyzed.lines) && analyzed.lines.length > 0) {
                  await store.patch(id, {
                    transcript: batchText,
                    transcriptSegments: analyzed.lines.map((line) => ({ speaker: line.speaker, text: line.text, at: Math.round(line.start) })),
                  })
                  logger?.info?.('meeting-minutes: speaker diarization done (' + String(analyzed.speakers) + ' speakers, ' + String(analyzed.lines.length) + ' lines)')
                } else if (Array.isArray(analyzed.lines) && analyzed.lines.length > 0) {
                  // 典型场景：18 分钟录音只认出 2 句（19 字），而流式转写已有 174 段。
                  // 保留流式转写和它的分段，避免把已识别内容整段覆盖掉。
                  logger?.warn?.('meeting-minutes: diarization result too short (' + String(batchText.replace(/\s+/g, '').length)
                    + ' chars vs ' + String((currentMeeting?.transcript ?? '').replace(/\s+/g, '').length) + ' chars); keeping the streamed transcript')
                }
              }
              if (settingsNow.correctTranscript === true) {
                const current = requireMeeting(store, id)
                if (typeof current.transcript === 'string' && current.transcript.trim() !== '') {
                  const correctionContext = buildCorrectionContext(store.snapshot().meetings, current)
                  const corrected = await summarizer.correctTranscript(current, {
                    selection: store.summaryModel,
                    terms: effectiveTerms(settingsNow),
                    context: correctionContext,
                    custom: settingsNow.summary.mode === 'custom' ? settingsNow.summary.custom : null,
                  })
                  if (settingsNow.reviewCorrections !== false) {
                    // 先存成「待审阅」的逐行差异，由界面勾选接受后再替换转写
                    const changes = diffTextLines(current.transcript, corrected)
                    if (changes.length > 0) {
                      await store.patch(id, {
                        correction: { at: new Date().toISOString(), original: current.transcript, corrected, changes },
                      })
                      logger?.info?.('meeting-minutes: transcript correction ready for review (' + String(changes.length) + ' changes)')
                    }
                  } else {
                    await store.patch(id, { transcript: corrected })
                    logger?.info?.('meeting-minutes: transcript corrected by LLM')
                  }
                }
              }
            } catch (error) {
              logger?.warn?.('meeting-minutes: post-process audio failed: ' + (error instanceof Error ? error.message : String(error)))
            }
          })()
        }
        return
      }

      if (segments.length === 4 && segments[2] === 'media' && segments[3] === 'reveal' && method === 'POST') {
        const meeting = requireMeeting(store, id)
        const body = await readJsonBody(req)
        const kind = String(body.kind ?? '')
        const entry = (Array.isArray(meeting.media) ? meeting.media : []).find((item) => item && item.kind === kind)
        if (entry === undefined) throw new Error('这场会议还没有生成该类型的文件')
        const revealed = revealMediaPath(entry.path)
        sendJson(res, 200, { ok: true, path: entry.path, revealed })
        return
      }

      if (segments.length === 4 && segments[2] === 'media' && segments[3] === 'open' && method === 'POST') {
        const meeting = requireMeeting(store, id)
        const body = await readJsonBody(req)
        const kind = String(body.kind ?? '')
        const entry = (Array.isArray(meeting.media) ? meeting.media : []).find((item) => item && item.kind === kind)
        if (entry === undefined) throw new Error('这场会议还没有生成该类型的文件')
        const opened = openMediaPath(entry.path)
        sendJson(res, 200, { ok: true, path: entry.path, opened })
        return
      }

      if (segments.length === 3 && segments[2] === 'export' && method === 'GET') {
        const meeting = requireMeeting(store, id)
        const rawFormat = url.searchParams.get('format')
    const format = rawFormat === 'md' ? 'md' : rawFormat === 'docx' ? 'docx' : 'html'
        const exported = await exportMeeting(meeting, format)
        sendJson(res, 200, { ok: true, ...exported })
        return
      }

      sendJson(res, 404, { ok: false, error: `未知接口：${method} ${path}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = typeof error?.status === 'number' ? error.status : 400
      sendJson(res, status, { ok: false, error: message })
    }
  }

  return ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
}

