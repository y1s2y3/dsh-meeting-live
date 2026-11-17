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
  effectiveCorrectionNotes,
  effectiveTerms,
  normalizeTermItems,
  parseTerms,
  validateCloudSettings,
  validateSummaryCustom,
} from './settings.js'
import { scanFolders } from './term-extract.js'
import { describeMerge, mergeSpeakerClusters } from './speaker-merge.js'
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
import { createWriteStream, existsSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CURRENT_VERSION, checkForUpdate } from './update-check.js'
import { chooseBestCandidate } from './speaker-quality.js'

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

/**
 * Encode one Windows path as the target Explorer can receive intact（与 DSH 自带
 * `@deepseek-ai/dsh-native-command` 的做法一致）：
 * Explorer 自己解析命令行，会在逗号/等号处截断；非 ASCII 用百分号编码它反而不认。
 * 所以先转 file URL，再把非 ASCII 的百分号编码还原成字面字符，最后只转义 `,` 和 `=`。
 */
function explorerTarget(target) {
  return pathToFileURL(target, { windows: true }).href
    .replace(/(?:%[89A-F][0-9A-F])+/gi, (escaped) => decodeURIComponent(escaped))
    .replaceAll(',', '%2C')
    .replaceAll('=', '%3D')
}

/**
 * 启动一个 GUI 程序，并观察「早期失败」：
 *   - `error` 事件（如找不到可执行文件）→ 失败；
 *   - 退出码非 0/1 → 失败（Explorer 把请求转交给已运行的桌面进程后自己退出 1，算成功）；
 *   - 超过 watchMs 还在运行 → 认为已交给系统，算成功。
 * 注意：**不能**传 `windowsHide: true` —— 它会给 GUI 进程带 SW_HIDE，窗口起来但不可见。
 */
function launchGui(command, args, spawnImpl = spawn, watchMs = 1200) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(value)
    }
    let child = null
    try {
      child = spawnImpl(command, args, { stdio: 'ignore', windowsHide: false })
    } catch {
      finish({ ok: false, code: null })
      return
    }
    child.on('error', () => finish({ ok: false, code: null }))
    child.on('exit', (code) => finish({ ok: code === 0 || code === 1, code }))
    timer = setTimeout(() => finish({ ok: true, code: null }), watchMs)
    if (timer !== null && typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * 在资源管理器里选中该文件（失败不影响主流程）。
 *
 * 2026-11-17 二次修复：点击「查看目录」仍无反应。对照 DSH 自带的打开实现后改成：
 *   ① 目标用 file URL 形式编码，`/select,<编码后的路径>` 必须是同一个参数；
 *   ② Explorer 转交成功后自身退出码是 1，要按成功处理；
 *   ③ 去掉 `windowsHide: true`（GUI 进程带 SW_HIDE 会「进程起来但窗口不可见」）；
 *   ④ 启动失败/退出码异常返回 false，让界面给出「没找到文件/打开失败」提示。
 */
export async function revealMediaPath(target, spawnImpl = spawn) {
  if (typeof target !== 'string' || target === '' || !existsSync(target)) return false
  try {
    if (process.platform === 'win32') {
      const result = await launchGui('explorer.exe', ['/select,' + explorerTarget(target)], spawnImpl)
      return result.ok
    }
    if (process.platform === 'darwin') {
      const child = spawnImpl('open', ['-R', target], { stdio: 'ignore' })
      child.on('error', () => {})
      if (typeof child.unref === 'function') child.unref()
      return true
    }
    const child = spawnImpl('xdg-open', [dirname(target)], { stdio: 'ignore' })
    child.on('error', () => {})
    if (typeof child.unref === 'function') child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * 用系统默认关联程序打开文件。
 * Windows 上走 Explorer（双击的默认解析链，不闪控制台、支持中文路径），
 * 与 DSH 自带实现一致；失败返回 false 由界面提示。
 */
export async function openMediaPath(target, spawnImpl = spawn) {
  if (process.env.DSH_MEETING_NO_OPEN === '1') return true
  if (typeof target !== 'string' || target === '' || !existsSync(target)) return false
  try {
    if (process.platform === 'win32') {
      const result = await launchGui('explorer.exe', [explorerTarget(target)], spawnImpl)
      return result.ok
    }
    if (process.platform === 'darwin') {
      const child = spawnImpl('open', [target], { stdio: 'ignore' })
      child.on('error', () => {})
      if (typeof child.unref === 'function') child.unref()
      return true
    }
    const child = spawnImpl('xdg-open', [target], { stdio: 'ignore' })
    child.on('error', () => {})
    if (typeof child.unref === 'function') child.unref()
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

/* ── 音频/视频文件导入（长音频）：宿主 ffmpeg 解码，不受浏览器内存上限 ──
 *
 * 旧做法是浏览器 `decodeAudioData` 把整份文件解成内存里的 AudioBuffer：
 * 1 小时立体声 44.1kHz 就要约 1.3 GB，所以只能硬性限制 60 分钟。
 * 现在改成「整份上传 → 宿主 ffmpeg 只解音频轨成 16kHz 单声道 WAV →
 * 按片识别」，内存里始终只有一片（几 MB），几小时的录音/录像都能处理。
 * 识别完成的转写由宿主直接写进会议，页面关掉也会继续跑完。
 */

/** 进行中的文件导入任务：meetingId → { status, stage, done, total, chars, seconds, error } */
const importAudioJobs = new Map()
/** 导入文件体积上限：2 GB（ffmpeg 只解音频轨，几小时会议视频通常远小于它）。 */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024 * 1024
/** 切片长度：本地引擎 90 秒；云端一句话识别单次 ≤60 秒（腾讯/阿里），取 55 秒。 */
const IMPORT_LOCAL_SLICE_SECONDS = 90
const IMPORT_CLOUD_SLICE_SECONDS = 55
/** 临时文件名前缀；正常结束即删，进程被杀留下的由启动时 sweep 清理。 */
const IMPORT_TEMP_PREFIX = '.import-'
/** 生成文件超过这个时长就认为卡死，主动停止。 */
const IMPORT_CONVERT_TIMEOUT_MS = 30 * 60 * 1000

/** 把请求体流式写到磁盘：几百 MB 的文件不在内存里再复制一份。 */
async function streamBodyToFile(req, targetPath, limit = IMPORT_MAX_BYTES) {
  const declared = Number(req.headers?.['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(`文件超过 ${Math.round(limit / 1024 / 1024 / 1024)} GB 上限，请先压缩或裁剪后再导入`)
  }
  await mkdir(dirname(targetPath), { recursive: true })
  let size = 0
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length
      if (size > limit) {
        callback(new Error(`文件超过 ${Math.round(limit / 1024 / 1024 / 1024)} GB 上限，请先压缩或裁剪后再导入`))
        return
      }
      callback(null, chunk)
    },
  })
  // 测试里的 req 是异步迭代器而不是 stream，Readable.from 能同时兼容两种形态。
  const source = typeof req.pipe === 'function' ? req : Readable.from(req)
  try {
    await pipeline(source, limiter, createWriteStream(targetPath))
  } catch (error) {
    await rm(targetPath, { force: true }).catch(() => { })
    throw error
  }
  return size
}

/** 用宿主 ffmpeg 把任意音频/视频文件转成 16kHz 单声道 PCM16 WAV（只解音频轨）。 */
async function decodeAudioToWav(sourcePath, targetPath) {
  const ffmpeg = findFfmpeg()
  if (ffmpeg === null) {
    throw new Error('本机没有找到 ffmpeg，无法解码音频/视频文件。请先安装 ffmpeg（Windows：winget install Gyan.FFmpeg），或改用「导入纪要」粘贴文本。')
  }
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', sourcePath,
    '-vn', '-sn', '-dn',
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    '-map_metadata', '-1',
    targetPath,
  ]
  // stderr 写到文件而不是管道：宿主沙箱里「管道 + 子进程」会 EPERM，
  // 文件描述符则没问题；顺带把 ffmpeg 的真实报错留给失败提示。
  const logPath = `${targetPath}.ffmpeg.log`
  const logHandle = await open(logPath, 'w')
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', logHandle.fd] })
      const timer = setTimeout(() => {
        try { child.kill() } catch { }
        reject(new Error('音频解码超过 30 分钟仍未结束，已停止（请先裁剪或转成 MP3 再导入）'))
      }, IMPORT_CONVERT_TIMEOUT_MS)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) { resolve(); return }
        readFile(logPath, 'utf8').then((text) => {
          const detail = String(text).trim().split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? ''
          reject(new Error('音频/视频解码失败（ffmpeg 退出码 ' + String(code) + '）'
            + (detail === '' ? '，请确认文件里有音轨' : '：' + detail.slice(0, 300))))
        }, () => {
          reject(new Error('音频/视频解码失败（ffmpeg 退出码 ' + String(code) + '）'))
        })
      })
    })
  } finally {
    await logHandle.close().catch(() => { })
    await rm(logPath, { force: true }).catch(() => { })
  }
}

/** 读 WAV 头，拿到 data 起点与总帧数；只读头部，不把整份音频读进内存。 */
async function readWavLayout(filePath) {
  const handle = await open(filePath, 'r')
  try {
    const fileSize = (await handle.stat()).size
    const head = Buffer.alloc(Math.min(1024 * 1024, Math.max(44, fileSize)))
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    if (bytesRead < 44 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('音频转码结果不是有效的 WAV 文件')
    }
    let offset = 12
    let format = null
    let dataOffset = -1
    let dataBytes = -1
    while (offset + 8 <= bytesRead) {
      const id = head.toString('ascii', offset, offset + 4)
      const size = head.readUInt32LE(offset + 4)
      const body = offset + 8
      if (id === 'fmt ') {
        format = {
          channels: head.readUInt16LE(body + 2),
          sampleRate: head.readUInt32LE(body + 4),
          bitsPerSample: head.readUInt16LE(body + 14),
        }
      } else if (id === 'data') {
        dataOffset = body
        dataBytes = Math.min(size, Math.max(0, fileSize - body))
        break
      }
      offset = body + size + (size % 2)
    }
    if (format === null || dataOffset < 0 || dataBytes < 0) throw new Error('音频转码结果缺少 WAV 头信息')
    if (format.sampleRate !== 16000 || format.channels !== 1 || format.bitsPerSample !== 16) {
      throw new Error(`音频转码结果格式异常（${format.sampleRate} Hz / ${format.channels} 声道 / ${format.bitsPerSample} bit）`)
    }
    return {
      dataOffset,
      sampleRate: format.sampleRate,
      samples: Math.floor(dataBytes / 2),
      fileSize,
    }
  } finally {
    await handle.close()
  }
}

/** 从磁盘按帧范围读出一片，并补上 canonical 44 字节 WAV 头。 */
async function readWavSlice(filePath, layout, startFrame, endFrame) {
  const frames = Math.max(0, Math.min(layout.samples, endFrame) - Math.max(0, startFrame))
  const payloadBytes = frames * 2
  const buffer = Buffer.alloc(44 + payloadBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + payloadBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(16000, 24)
  buffer.writeUInt32LE(32000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(payloadBytes, 40)
  if (payloadBytes > 0) {
    const handle = await open(filePath, 'r')
    try {
      let read = 0
      const position = layout.dataOffset + Math.max(0, startFrame) * 2
      while (read < payloadBytes) {
        const result = await handle.read(buffer, 44 + read, payloadBytes - read, position + read)
        if (result.bytesRead <= 0) break
        read += result.bytesRead
      }
      if (read < payloadBytes) buffer.writeUInt32LE(read, 40)
    } finally {
      await handle.close()
    }
  }
  return buffer
}

/**
 * 识别一片 16kHz 单声道 PCM16 WAV，按当前转写引擎路由。
 * 空结果（静音片）降级成空文本而不抛错，与实时转写、整段重转写保持一致。
 */
async function transcribeWavBytes({ deps, store, bytes, language, providerId, logger }) {
  const transcribeSettings = store.settings.transcribe
  const engine = transcribeSettings.provider
  try {
    if (engine === 'paraformer-local' && deps.paraformer !== undefined && deps.paraformer !== null && deps.paraformer.available() === true) {
      return await deps.paraformer.transcribeWav(bytes)
    }
    if (engine.startsWith('cloud-') === true) {
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
      return { text: cloudResult.text, audioSeconds: Math.round(audioSeconds * 100) / 100, inferenceSeconds: 0 }
    }
    return await deps.asr.transcribeWav(bytes, { language, providerId })
  } catch (error) {
    // 静音片、被中断的分片、刚开头还没开口都属于正常现象：按空结果继续，
    // 否则一片失败会让整场导入中断。真故障仍然抛出并写日志。
    const failureMessage = error instanceof Error ? error.message : String(error)
    const benignFailure = failureMessage === '语音识别没有识别出任何文字'
      || failureMessage === '音频数据无效'
      || failureMessage === '音频数据不是 WAV 格式'
      || failureMessage === '只支持 16bit PCM WAV'
      || failureMessage === '音频数据里没有找到 PCM 数据段'
    if (!benignFailure) {
      logger?.warn?.(`meeting-minutes: transcribe failed: ${failureMessage}`)
      throw error
    }
    const audioSeconds = Math.max(0, (bytes.length - 44) / (16000 * 2))
    logger?.info?.(`meeting-minutes: chunk had no usable audio (${audioSeconds.toFixed(1)}s, ${failureMessage}); keeping the session`)
    return { text: '', audioSeconds: Math.round(audioSeconds * 100) / 100, inferenceSeconds: 0 }
  }
}

/** 后台跑一次文件导入：转码 → 按片识别 → 把转写写进会议。 */
async function runImportAudioJob({ deps, store, meetingId, sourcePath, logger }) {
  const job = importAudioJobs.get(meetingId)
  const directory = dirname(sourcePath)
  const wavPath = join(directory, `${IMPORT_TEMP_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`)
  try {
    if (job === undefined) return
    job.stage = 'converting'
    logger?.info?.(`meeting-minutes: import ${meetingId} converting ${Math.round((Number(job.bytes) || 0) / 1048576)}MB`)
    await decodeAudioToWav(sourcePath, wavPath)
    const layout = await readWavLayout(wavPath)
    const seconds = layout.samples / layout.sampleRate
    if (!(seconds > 0.3)) throw new Error('音频太短，无法识别')
    job.seconds = Math.round(seconds)
    job.stage = 'transcribing'
    const provider = String(store.settings?.transcribe?.provider ?? '')
    const sliceSeconds = provider.startsWith('cloud-') ? IMPORT_CLOUD_SLICE_SECONDS : IMPORT_LOCAL_SLICE_SECONDS
    const slices = planRetranscribeSlices(layout.samples, layout.sampleRate, sliceSeconds)
    job.total = slices.length
    logger?.info?.(`meeting-minutes: import ${meetingId} decoding done (${job.seconds}s, ${job.total} slices)`)
    const texts = []
    for (const slice of slices) {
      if (store.get(meetingId) === null) throw new Error('这场会议已被删除，导入已停止')
      const wav = await readWavSlice(wavPath, layout, slice.startFrame, slice.endFrame)
      const result = await transcribeWavBytes({ deps, store, bytes: wav, logger })
      const text = String(result?.text ?? '').replace(/\s+/g, ' ').trim()
      if (text !== '') texts.push(text)
      job.done += 1
      job.chars = mergeRetranscribeTexts(texts).length
    }
    const text = mergeRetranscribeTexts(texts)
    if (text === '') throw new Error('没有识别到文字，请确认音频中有清晰语音，或改用文本导入')
    await store.patch(meetingId, { transcript: text, transcriptSeconds: Math.round(seconds) })
    job.chars = text.length
    job.status = 'done'
    job.stage = 'done'
    job.finishedAt = Date.now()
    logger?.info?.(`meeting-minutes: import ${meetingId} done (${job.chars} chars, ${job.total} slices)`)
  } catch (error) {
    if (job !== undefined) {
      job.status = 'failed'
      job.stage = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
      job.finishedAt = Date.now()
    }
    logger?.warn?.(`meeting-minutes: import failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await rm(wavPath, { force: true }).catch(() => { })
    await rm(sourcePath, { force: true }).catch(() => { })
  }
}

/** 进程被杀会留下临时文件；启动时清掉 6 小时前的残留（长任务保护期）。 */
function sweepStaleImportFiles(logger) {
  try {
    const root = mediaRoot()
    if (!existsSync(root)) return
    const cutoff = Date.now() - 6 * 60 * 60 * 1000
    for (const name of readdirSync(root)) {
      const directory = join(root, name)
      let entries = []
      try {
        entries = readdirSync(directory)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.startsWith(IMPORT_TEMP_PREFIX)) continue
        const full = join(directory, entry)
        try {
          if (statSync(full).mtimeMs < cutoff) void rm(full, { force: true }).catch(() => { })
        } catch {
          // 单个文件删不掉不影响启动。
        }
      }
    }
  } catch (error) {
    logger?.warn?.(`meeting-minutes: sweep import temp files failed: ${String(error?.message ?? error)}`)
  }
}


/* ── 声纹重新分离（给已有分段补 S1/S2 标签） ─────────────────────────── */
/** 进行中的声纹分离任务：meetingId → { status, stage, speakers, error, note, startedAt } */
const diarizeJobs = new Map()
/** 进行中的分离子进程：meetingId → ChildProcess（用于取消） */
const diarizeChildren = new Map()
/** 单次声纹分离的最长运行时间（1 小时音频在 CPU 上约 7–10 分钟，留足余量）。 */
const DIARIZE_MAX_MS = 30 * 60 * 1000
/** 自动聚类超过这个人数基本是远场过度分割，界面会提示可指定人数重试。 */
const DIARIZE_WARN_SPEAKERS = 12
/** 声纹分离结果缓存目录：同一段音频（路径+大小+mtime 相同）重试时直接复用，避免每次再等十分钟。 */
const DIARIZE_CACHE_DIR = join(homedir(), '.dsh', 'storages', 'meeting-minutes-diarize-cache')

/**
 * 声纹分离缓存键：音频路径 + 大小 + mtime。
 * 音频文件没变时，同一段录音的分离结果可以直接复用。
 * @param audioPath - 音频绝对路径。
 * @returns 稳定缓存键（失败时返回空串）。
 */
export function diarizeCacheKey(audioPath) {
  try {
    const info = statSync(audioPath)
    return createHash('sha1').update(String(audioPath) + '|' + String(info.size) + '|' + String(Math.round(info.mtimeMs))).digest('hex')
  } catch {
    return ''
  }
}

/** 读声纹分离缓存：`{ ok: true, numClusters, speakers, lines }`，没有时返回 null。 */
export async function readDiarizeCache(audioPath, cacheDir = DIARIZE_CACHE_DIR) {
  const key = diarizeCacheKey(audioPath)
  if (key === '') return null
  try {
    const parsed = JSON.parse(await readFile(join(cacheDir, key + '.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || parsed.ok !== true || !Array.isArray(parsed.lines)) return null
    return parsed
  } catch {
    return null
  }
}

/** 写声纹分离缓存（失败不影响主流程）。`textLines` 是按说话人切句时带文本的结果。 */
export async function writeDiarizeCache(audioPath, payload, cacheDir = DIARIZE_CACHE_DIR) {
  const key = diarizeCacheKey(audioPath)
  if (key === '') return false
  try {
    await mkdir(cacheDir, { recursive: true })
    await writeFile(join(cacheDir, key + '.json'), JSON.stringify({
      ok: true,
      numClusters: Number(payload?.numClusters) || 0,
      speakers: Number(payload?.speakers) || 0,
      lines: Array.isArray(payload?.lines) ? payload.lines : [],
      textLines: Array.isArray(payload?.textLines) ? payload.textLines : [],
      quality: payload?.quality !== null && typeof payload?.quality === 'object' ? payload.quality : null,
      speakerEmbeddings: payload?.speakerEmbeddings !== null && typeof payload?.speakerEmbeddings === 'object' ? payload.speakerEmbeddings : null,
      createdAt: new Date().toISOString(),
    }), 'utf8')
    return true
  } catch {
    return false
  }
}


/**
 * 用声纹分离结果给**已有转写分段**打说话人标签（保留原有文字与时间，不重写文本）。
 *
 * @param segments - `[{ speaker, text, at }]`，`at` 是距录音开始的秒数。
 * @param lines - 声纹分离结果 `[{ speaker: 'S1', start, end, text }]`。
 * @returns `{ segments, assigned, total }`；没有可用区间时 segments 为 null。
 */
export function relabelSegmentsBySpeaker(segments, lines) {
  const rows = Array.isArray(segments) ? segments : []
  const ranges = (Array.isArray(lines) ? lines : [])
    .map((line) => {
      const speaker = typeof line?.speaker === 'string' ? line.speaker.trim() : ''
      const start = Number(line?.start)
      const end = Number(line?.end)
      if (speaker === '' || !Number.isFinite(start)) return null
      return { speaker, start: Math.max(0, start), end: Number.isFinite(end) ? Math.max(start, end) : start }
    })
    .filter((range) => range !== null)
  if (ranges.length === 0) return { segments: null, assigned: 0, total: 0 }
  let assigned = 0
  const next = rows.map((segment) => {
    const at = Number(segment?.at)
    if (!Number.isFinite(at) || at < 0) return { ...segment }
    // 1) 落在某条声纹区间的起止范围内（前后各留 2 秒容差）
    let hit = ranges.find((range) => at >= range.start - 2 && at <= range.end + 2)
    // 2) 没命中就找最近的区间起点（20 秒内），避免切片边界造成整段没标签
    if (hit === undefined) {
      let best = null
      let bestDistance = Infinity
      for (const range of ranges) {
        const distance = Math.abs(range.start - at)
        if (distance < bestDistance) {
          bestDistance = distance
          best = range
        }
      }
      if (best !== null && bestDistance <= 20) hit = best
    }
    if (hit === undefined) return { ...segment }
    assigned += 1
    return { ...segment, speaker: hit.speaker }
  })
  // 3) 还没匹配上的（长静音、切片错位）：沿用相邻已标注分段的说话人，减少「空标签」。
  //    只在前后 90 秒内找，避免跨大段空白乱套。
  for (let index = 0; index < next.length; index += 1) {
    if (next[index].speaker !== undefined && next[index].speaker !== '') continue
    let previous = null
    for (let probe = index - 1; probe >= 0; probe -= 1) {
      const label = next[probe].speaker
      if (typeof label === 'string' && label !== '') {
        const gap = Math.abs(Number(next[index].at) - Number(next[probe].at))
        if (gap <= 90) previous = label
        break
      }
    }
    let following = null
    for (let probe = index + 1; probe < next.length; probe += 1) {
      const label = next[probe].speaker
      if (typeof label === 'string' && label !== '') {
        const gap = Math.abs(Number(next[probe].at) - Number(next[index].at))
        if (gap <= 90) following = label
        break
      }
    }
    const label = previous !== null ? previous : following
    if (label !== null) {
      next[index] = { ...next[index], speaker: label }
      assigned += 1
    }
  }
  return { segments: next, assigned, total: rows.length }
}

/** 由分段重建带说话人标记的转写全文（与 store 的自愈逻辑保持一致）。 */
export function buildTranscriptFromSegments(segments, options = {}) {
  const merged = options.mergeSpeakerTurns === true ? mergeSegmentsBySpeaker(segments) : null
  return (merged !== null ? merged : (Array.isArray(segments) ? segments : []))
    .map((segment) => {
      const speaker = typeof segment?.speaker === 'string' ? segment.speaker.trim() : ''
      const text = String(segment?.text ?? '')
      return speaker === '' ? text : `${speaker}：${text}`
    })
    .join('\n')
}

/**
 * 合并「连续同一说话人」的分段：更接近听悟那种「一段发言」的排版。
 *
 * 说明：只合并相邻且同一 speaker 的段；中间隔太久（默认 5 分钟）或换人就开新段，
 * 所以插话、来回讨论仍保留原来的说话人顺序。
 *
 * @param segments - `[{ speaker, text, at }]`。
 * @param options - `{ maxGapSeconds }`：超过这个间隔就开新段。
 */
export function mergeSegmentsBySpeaker(segments, options = {}) {
  const rows = Array.isArray(segments) ? segments : []
  const maxGapSeconds = Number(options.maxGapSeconds) > 0 ? Number(options.maxGapSeconds) : 300
  const merged = []
  let previousAt = null
  for (const segment of rows) {
    const speaker = typeof segment?.speaker === 'string' ? segment.speaker.trim() : ''
    const text = String(segment?.text ?? '').trim()
    if (text === '') continue
    const at = Number(segment?.at)
    const hasAt = Number.isFinite(at)
    const previous = merged[merged.length - 1]
    const gapTooLarge = previous !== undefined && previousAt !== null && hasAt && at - previousAt > maxGapSeconds
    if (previous !== undefined && previous.speaker === speaker && !gapTooLarge) {
      // 同一人连续发言：拼成一段；原文没有结尾标点时补一个句号，避免两句连在一起。
      const needsJoiner = !/[。！？；，、]$/.test(previous.text) && !/^[。！？；，、]/.test(text)
      previous.text = previous.text + (needsJoiner ? '。' : '') + text
      if (hasAt) previousAt = at
      continue
    }
    merged.push({ ...segment, speaker, text })
    previousAt = hasAt ? at : null
  }
  return merged
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

/**
 * 把声纹分离得到的说话人区间回填到会议分段，并重建带 S1/S2 标记的转写文本。
 * @param options - `{ store, meetingId, lines, speakers, job, logger, noteSuffix }`。
 * @returns `{ assigned, total }`。
 */
async function applyDiarizeLines({ store, meetingId, lines, speakers, job, logger, noteSuffix = '' }) {
  const rows = Array.isArray(lines) ? lines : []
  const current = store.get(meetingId)
  const segments = Array.isArray(current?.transcriptSegments) ? current.transcriptSegments : []
  if (rows.length === 0) throw new Error('声纹分离没有识别出任何说话人片段（音频可能太短或太轻）')
  if (segments.length === 0) {
    throw new Error('这场会议还没有分段转写，无法回填说话人标签：请先点「整段重转写」再重新分离')
  }
  const { segments: relabeled, assigned, total } = relabelSegmentsBySpeaker(segments, rows)
  if (relabeled === null || total === 0 || assigned < Math.max(1, Math.round(total * 0.5))) {
    throw new Error('声纹分离结果与转写时间对不上（匹配 ' + String(assigned) + '/' + String(total) + ' 段），建议先「整段重转写」再试')
  }
  await store.patch(meetingId, {
    transcriptSegments: relabeled,
    transcript: buildTranscriptFromSegments(relabeled, { mergeSpeakerTurns: true }),
  })
  job.status = 'done'
  job.stage = 'done'
  job.speakers = Number(speakers) || [...new Set(rows.map((line) => line?.speaker).filter(Boolean))].length
  job.counts = countSpeakers(relabeled)
  const tooMany = job.speakers > DIARIZE_WARN_SPEAKERS
  job.note = '已按声纹重新分离：' + String(job.speakers) + ' 位说话人，标注 ' + String(assigned) + '/' + String(total) + ' 段'
    + (tooMany ? '。检测到的说话人数偏多（远场录音容易过度分割），可指定人数重试' : '')
    + noteSuffix
  return { assigned, total }
}

/** 统计每个说话人的段数：`{ S1: 39, S2: 2, '': 23 }`。 */
function countSpeakers(segments) {
  const counts = {}
  for (const segment of Array.isArray(segments) ? segments : []) {
    const key = typeof segment?.speaker === 'string' && segment.speaker !== '' ? segment.speaker : '（空）'
    counts[key] = (counts[key] || 0) + 1
  }
  return counts
}

/**
 * 按设置把「同一个人被拆成多个簇」合并回去（相近音色二次合并）。
 * @param options - `{ lines, centers, settings }`。
 * @returns `{ lines, merge }`；没有可合并内容时 merge 为 null。
 */
function mergeDiarizePayload({ lines, centers, settings }) {
  const rows = Array.isArray(lines) ? lines : []
  if (settings?.diarizeMerge === false) return { lines: rows, merge: null }
  if (centers === null || centers === undefined) return { lines: rows, merge: null }
  const threshold = Number(settings?.diarizeMergeThreshold) > 0 ? Number(settings.diarizeMergeThreshold) : 0.68
  try {
    const merged = mergeSpeakerClusters({ lines: rows, centers, threshold })
    if (merged.merged !== true) return { lines: rows, merge: null }
    return { lines: merged.lines, merge: { before: merged.before, after: merged.after, threshold, groups: merged.groups } }
  } catch {
    return { lines: rows, merge: null }
  }
}

/**
 * 「按说话人切句」：用声纹回合 + **逐回合识别的文本**重建原文，一行一句、一行一个说话人。
 * 适合原文是 30 秒大段（一段里混了两个人）的会议。
 * @param options - `{ store, meetingId, lines, speakers, job, logger }`；lines 需带 `text`。
 * @returns `{ assigned, total }`。
 */
export async function applyTurnLines({ store, meetingId, lines, speakers, job, logger }) {
  const rows = (Array.isArray(lines) ? lines : [])
    .map((line) => ({
      speaker: typeof line?.speaker === 'string' ? line.speaker.trim() : '',
      text: String(line?.text ?? '').replace(/\s+/g, ' ').trim(),
      start: Math.max(0, Number(line?.start) || 0),
    }))
    .filter((line) => line.text !== '')
  if (rows.length === 0) throw new Error('按说话人切句后没有任何文本（音频可能太轻或静音）')
  const current = store.get(meetingId)
  const currentText = String(current?.transcript ?? '')
  const rebuilt = rows.map((row) => (row.speaker === '' ? row.text : row.speaker + '：' + row.text)).join('\n')
  // 保护：切句后文本明显变少说明识别大面积失败，别覆盖原转写。
  const minChars = Math.max(80, Math.round(currentText.length * 0.6))
  if (rebuilt.length < minChars) {
    throw new Error('按说话人切句后文本明显变少（' + String(rebuilt.length) + ' < ' + String(minChars) + ' 字），已保留原转写；可稍后重试或改用「重新分离说话人」')
  }
  const transcriptSegments = rows.map((row) => ({ speaker: row.speaker, text: row.text, at: Math.round(row.start) }))
  await store.patch(meetingId, { transcript: rebuilt, transcriptSegments })
  job.status = 'done'
  job.stage = 'done'
  job.speakers = Number(speakers) || [...new Set(rows.map((row) => row.speaker).filter(Boolean))].length
  job.counts = countSpeakers(transcriptSegments)
  job.note = '已按说话人切句：' + String(job.speakers) + ' 位说话人、' + String(rows.length) + ' 句（每句一个说话人）'
  logger?.info?.('meeting-minutes: diarize rebuilt transcript by speaker turns (' + String(rows.length) + ' lines, ' + String(job.speakers) + ' speakers)')
  return { assigned: rows.length, total: rows.length }
}

/**
 * 跑一次声纹分离子进程（自动人数优选会对同一段音频跑多档）。
 *
 * @param options - `{ audioPath, models, numClusters, splitTurns, job, logger, meetingId }`。
 * @returns 子进程写出的结果 `{ ok, speakers, lines, quality, speakerEmbeddings }`。
 */
async function runDiarizeWorkerOnce({ audioPath, models, numClusters, splitTurns, job, logger, meetingId }) {
  const outputPath = join(tmpdir(), 'dsh-diarize-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.json')
  const argsPath = outputPath + '.args.json'
  let child = null
  let stderrTail = ''
  try {
    await writeFile(argsPath, JSON.stringify({
      audioPath,
      models,
      numClusters: Number(numClusters) > 0 ? Math.round(Number(numClusters)) : 0,
      outputPath,
      splitTurns,
    }), 'utf8')
    const workerPath = fileURLToPath(new URL('./diarize-worker.js', import.meta.url))
    job.stage = 'starting'
    try {
      child = spawn(process.execPath, [workerPath, argsPath], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      throw new Error('无法启动声纹分离进程：' + (error instanceof Error ? error.message : String(error)))
    }
    diarizeChildren.set(meetingId, child)
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk)
      if (text.includes('STAGE loading')) job.stage = 'loading'
      if (text.includes('STAGE diarizing')) job.stage = 'diarizing'
      if (text.includes('STAGE embedding')) job.stage = 'embedding'
      for (const line of text.split('\n')) {
        if (line.startsWith('STAGE transcribing')) {
          job.stage = 'transcribing'
          const match = /(\d+)\s*\/\s*(\d+)/.exec(line)
          if (match !== null) {
            job.transcribeDone = Number(match[1])
            job.transcribeTotal = Number(match[2])
          }
        }
        if (line.startsWith('STAGE done')) job.stage = splitTurns ? 'rebuilding' : 'relabeling'
      }
    })
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-800)
    })
    const exited = await new Promise((resolve) => {
      let settled = false
      const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
      child.on('error', (error) => finish({ code: -1, errorMessage: error instanceof Error ? error.message : String(error) }))
      child.on('exit', (code) => finish({ code }))
      setTimeout(() => {
        try { child.kill() } catch { /* ignore */ }
        finish({ code: -2, timeout: true })
      }, DIARIZE_MAX_MS)
    })
    diarizeChildren.delete(meetingId)
    if (job.status === 'cancelled') throw new Error('已取消声纹分离（原转写保持不变）')
    if (exited.timeout === true) throw new Error('声纹分离超过 ' + String(Math.round(DIARIZE_MAX_MS / 60000)) + ' 分钟仍未结束，已停止（可改用指定人数重试）')
    let parsed = null
    try {
      parsed = JSON.parse(await readFile(outputPath, 'utf8'))
    } catch {
      parsed = null
    }
    if (parsed === null || parsed.ok !== true) {
      const reason = parsed !== null && typeof parsed.error === 'string' && parsed.error !== ''
        ? parsed.error
        : (stderrTail.trim() !== '' ? stderrTail.trim().split('\n').slice(-2).join(' ') : '分离进程异常退出（code ' + String(exited.code) + '）')
      throw new Error(reason)
    }
    return parsed
  } finally {
    if (child !== null) {
      diarizeChildren.delete(meetingId)
      try { child.kill() } catch { /* already exited */ }
    }
    await rm(outputPath, { force: true }).catch(() => {})
    await rm(argsPath, { force: true }).catch(() => {})
  }
}

/**
 * 后台用声纹（pyannote + cam++）重新分离说话人：
 *   - **在独立子进程里跑**（sherpa 的分离是同步 CPU 计算，放在宿主进程会阻塞事件循环、
 *     页面拿不到进度、整个插件卡住；1 小时音频实测约 9–10 分钟）；
 *   - 优先保留现有转写文本与时间，只给分段补 S1/S2 标签；
 *   - 同一段音频算过一次就写进缓存，重试时直接复用（`readDiarizeCache`），不再等十分钟。
 */
async function runDiarizeJob({ deps, store, meetingId, audioPath, logger, speakers = 0, mode = 'relabel' }) {
  const job = diarizeJobs.get(meetingId)
  if (job === undefined) return
  const splitTurns = mode === 'turns'
  const outputPath = join(tmpdir(), 'dsh-diarize-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.json')
  const argsPath = outputPath + '.args.json'
  let child = null
  let stderrTail = ''
  try {
    if (deps.paraformer === undefined || deps.paraformer === null
      || deps.paraformer.diarizationAvailable?.() !== true) {
      job.status = 'error'
      job.error = '说话人分离模型未就绪：请到设置 → 模型配置里下载 pyannote 分段与 cam++ 声纹模型'
      return
    }
    // 先查缓存：同一段音频算过一次就直接复用（自动/相同人数才复用，指定人数不同则重算）。
    const cached = await readDiarizeCache(audioPath)
    const cachedMatch = cached !== null && (Number(speakers) === 0 || Number(cached.numClusters) === Number(speakers))
    if (cachedMatch) {
      job.stage = 'cached'
      try {
        const cachedSettings = store.settings
        if (splitTurns) {
          // 切句模式需要带文本的缓存；没有就回落到 worker 重新算。
          if (Array.isArray(cached.textLines) && cached.textLines.length > 0) {
            const mergedTurns = mergeDiarizePayload({ lines: cached.textLines, centers: cached.speakerEmbeddings, settings: cachedSettings })
            if (mergedTurns.merge !== null) job.merge = mergedTurns.merge
            await applyTurnLines({ store, meetingId, lines: mergedTurns.lines, speakers: cached.speakers, job, logger })
            if (job.merge !== undefined && job.merge !== null) job.note = String(job.note ?? '') + '（' + describeMerge(job.merge) + '）'
            logger?.info?.('meeting-minutes: diarize turns applied from cache (' + String(job.speakers) + ' speakers)')
            return
          }
        } else {
          const mergedLines = mergeDiarizePayload({ lines: cached.lines, centers: cached.speakerEmbeddings, settings: cachedSettings })
          if (mergedLines.merge !== null) job.merge = mergedLines.merge
          await applyDiarizeLines({
            store,
            meetingId,
            lines: mergedLines.lines,
            speakers: cached.speakers,
            job,
            logger,
            noteSuffix: '（复用本机已算好的分离结果，未重新计算）'
              + (job.merge !== undefined && job.merge !== null ? '（' + describeMerge(job.merge) + '）' : ''),
          })
          logger?.info?.('meeting-minutes: diarize applied from cache (' + String(job.speakers) + ' speakers)')
          return
        }
      } catch (error) {
        logger?.warn?.('meeting-minutes: diarize cache not applicable, recomputing: ' + String(error instanceof Error ? error.message : error))
      }
    }
    const models = deps.modelManager?.paths?.() ?? {}
    const requestedClusters = Number(speakers) > 0 ? Math.round(Number(speakers)) : 0
    const autoSpeakers = requestedClusters === 0 && !splitTurns
      && store.settings?.diarizeAutoSpeakers !== false
    let usedClusters = requestedClusters
    let parsed = await runDiarizeWorkerOnce({ audioPath, models, numClusters: requestedClusters, splitTurns, job, logger, meetingId })
    // 自动人数优选：首档是自动聚类；若明显过分割（>4 人），补跑 4/3 人档，按声纹质量选最优。
    if (autoSpeakers && parsed.quality !== null && parsed.quality !== undefined
      && Number(parsed.quality.embedded) > 0 && Number(parsed.quality.speakers) > 4) {
      const candidates = [{ parsed, numClusters: 0 }]
      for (const forced of [4, 3]) {
        if (forced >= Number(parsed.quality?.speakers ?? 0)) continue
        if (job.status === 'cancelled') break
        job.stage = 'diarizing ' + String(forced) + ' 人'
        try {
          const candidate = await runDiarizeWorkerOnce({ audioPath, models, numClusters: forced, splitTurns, job, logger, meetingId })
          if (candidate.quality !== null && candidate.quality !== undefined) candidates.push({ parsed: candidate, numClusters: forced })
        } catch (error) {
          logger?.warn?.('meeting-minutes: diarize auto candidate failed (' + String(forced) + '): ' + String(error instanceof Error ? error.message : error))
        }
      }
      const best = chooseBestCandidate(candidates)
      if (best !== null && best.parsed !== parsed) {
        logger?.info?.('meeting-minutes: diarize auto picked ' + String(best.numClusters) + ' clusters (score '
          + String(best.parsed.quality?.score) + ' vs ' + String(parsed.quality?.score) + ')')
        parsed = best.parsed
        usedClusters = best.numClusters
      }
    }
    const rawLines = Array.isArray(parsed.lines) ? parsed.lines : []
    // 相近音色二次合并：用每个说话人的声纹质心，把同一个人被拆开的簇合回去。
    const mergedPayload = mergeDiarizePayload({ lines: rawLines, centers: parsed.speakerEmbeddings, settings: store.settings })
    const lines = mergedPayload.lines
    if (mergedPayload.merge !== null) {
      job.merge = mergedPayload.merge
      job.speakers = mergedPayload.merge.after
      logger?.info?.('meeting-minutes: ' + describeMerge(mergedPayload.merge))
    }
    if (splitTurns) {
      await applyTurnLines({ store, meetingId, lines, speakers: job.speakers || parsed.speakers, job, logger })
      if (job.merge !== undefined && job.merge !== null) job.note = String(job.note ?? '') + '（' + describeMerge(job.merge) + '）'
      // 缓存里同时保存「回合区间」与「带文本的逐句结果」，下次切句可直接复用。
      // 注意：缓存的是**合并前**的原始簇 + 质心，这样以后改阈值也能直接复用缓存重新合并。
      await writeDiarizeCache(audioPath, {
        numClusters: usedClusters,
        speakers: parsed.speakers,
        lines: rawLines.map((line) => ({ speaker: line.speaker, start: line.start, end: line.end })),
        textLines: rawLines.map((line) => ({ speaker: line.speaker, text: line.text, start: line.start, end: line.end })),
        quality: parsed.quality ?? null,
        speakerEmbeddings: parsed.speakerEmbeddings ?? null,
      })
      return
    }
    const { assigned, total } = await applyDiarizeLines({
      store,
      meetingId,
      lines,
      speakers: job.speakers || parsed.speakers,
      job,
      logger,
    })
    if (job.merge !== undefined && job.merge !== null) job.note = String(job.note ?? '') + '（' + describeMerge(job.merge) + '）'
    // 记住这次结果，重试时直接复用（指定人数不同则走重新计算）。同样缓存合并前的原始簇。
    await writeDiarizeCache(audioPath, {
      numClusters: usedClusters,
      speakers: parsed.speakers,
      lines: rawLines,
      quality: parsed.quality ?? null,
      speakerEmbeddings: parsed.speakerEmbeddings ?? null,
    })
    logger?.info?.(`meeting-minutes: diarize relabeled ${assigned}/${total} segments (${job.speakers} speakers${Number(speakers) > 0 ? ', forced ' + String(speakers) : ''})`)
  } catch (error) {
    if (job.status !== 'cancelled') {
      job.status = 'error'
      job.error = error instanceof Error ? error.message : String(error)
      logger?.warn?.('meeting-minutes: diarize failed: ' + job.error)
    }
  } finally {
    if (child !== null) {
      diarizeChildren.delete(meetingId)
      try { child.kill() } catch { /* already exited */ }
    }
    await rm(outputPath, { force: true }).catch(() => {})
    await rm(argsPath, { force: true }).catch(() => {})
  }
}

/**
 * 启动一次声纹分离任务（同一会议同时只允许一个，正在跑时直接复用现有任务）。
 *
 * **一定要通过它来启动**——包括「音频上传后自动分离」。历史版本在上传回调里直接调用同步的
 * `transcribeFileWithSpeakers`，长会议会**阻塞宿主事件循环 10+ 分钟**（页面与其它插件全卡住），
 * 这是「停止长会议要等很久」的根因。现在统一走独立子进程 + 缓存，宿主只轮询状态。
 */
function startDiarizeJob({ deps, store, meetingId, audioPath, logger, speakers = 0, mode = 'relabel', reason = 'manual' }) {
  const running = diarizeJobs.get(meetingId)
  if (running !== undefined && running.status === 'running') return running
  const job = {
    status: 'running',
    stage: 'starting',
    mode: mode === 'turns' ? 'turns' : 'relabel',
    speakers: 0,
    forcedSpeakers: Number(speakers) > 0 ? Math.round(Number(speakers)) : 0,
    reason,
    error: null,
    note: null,
    startedAt: Date.now(),
  }
  diarizeJobs.set(meetingId, job)
  void runDiarizeJob({ deps, store, meetingId, audioPath, logger, speakers: job.forcedSpeakers, mode: job.mode })
  return job
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
      // 浏览器据此决定「录音转写」走宿主解码（长音频、不限 60 分钟）还是旧的浏览器解码。
      // 用单独字段而不是 ffmpegReady：页面先刷新、宿主还没重启时，旧宿主没有这个字段，
      // 前端会自动留在旧路径，不会调到不存在的接口。
      importLongAudio: findFfmpeg() !== null,
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

  // 清掉上次进程被杀时留下的导入临时文件（异步删，不阻塞启动）。
  sweepStaleImportFiles(logger)

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
        const result = await transcribeWavBytes({ deps, store, bytes, language, providerId, logger })
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

      // 音频/视频文件导入（长音频）：POST 上传并启动后台任务，GET 查进度。
      // 宿主用 ffmpeg 分片解码+识别，不占浏览器内存，也不受 60 分钟上限限制；
      // 识别完成的转写直接写进会议，页面关掉也会继续跑完。
      if (segments.length === 4 && segments[2] === 'audio' && segments[3] === 'import' && (method === 'POST' || method === 'GET')) {
        requireMeeting(store, id)
        if (method === 'GET') {
          const job = importAudioJobs.get(id)
          sendJson(res, 200, {
            ok: true,
            job: job === undefined
              ? { status: 'idle', stage: 'idle', done: 0, total: 0, chars: 0, seconds: 0 }
              : { ...job },
          })
          return
        }
        const running = importAudioJobs.get(id)
        if (running !== undefined && running.status === 'running') {
          sendJson(res, 200, { ok: true, job: { ...running } })
          return
        }
        if (findFfmpeg() === null) {
          throw new Error('本机没有找到 ffmpeg，无法解码音频/视频文件。请先安装 ffmpeg（Windows：winget install Gyan.FFmpeg）后重启 DSH Desktop，或改用「导入纪要」粘贴文本。')
        }
        const name = safeMediaName(url.searchParams.get('name'), '导入音频')
        const directory = join(mediaRoot(), id)
        await mkdir(directory, { recursive: true })
        const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const sourcePath = join(directory, `${IMPORT_TEMP_PREFIX}${stamp}-${name}`)
        const bytes = await streamBodyToFile(req, sourcePath)
        if (bytes === 0) throw new Error('没有收到文件内容')
        const job = {
          status: 'running',
          stage: 'converting',
          done: 0,
          total: 0,
          chars: 0,
          seconds: 0,
          bytes,
          error: null,
          startedAt: Date.now(),
        }
        importAudioJobs.set(id, job)
        // 先返回：上传/转码/识别都在响应之后进行，长音频不会让请求超时。
        sendJson(res, 200, { ok: true, job: { ...job } })
        void runImportAudioJob({ deps, store, meetingId: id, sourcePath, logger })
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

      // 声纹重新分离：POST 启动（独立子进程跑，宿主不等它），GET 查进度，POST /cancel 取消。
      // 用于给已有转写分段补 S1/S2 说话人标签（实时录音里的 A/B/C/D 只是音高估算）。
      if (segments.length === 4 && segments[2] === 'diarize' && segments[3] === 'cancel' && method === 'POST') {
        requireMeeting(store, id)
        const job = diarizeJobs.get(id)
        if (job === undefined || job.status !== 'running') {
          sendJson(res, 200, { ok: true, job: job ? { ...job } : { status: 'idle', stage: 'idle' } })
          return
        }
        job.status = 'cancelled'
        job.stage = 'cancelled'
        job.error = '已取消（原转写保持不变）'
        const child = diarizeChildren.get(id)
        if (child !== undefined) {
          try { child.kill() } catch { /* already exited */ }
          diarizeChildren.delete(id)
        }
        logger?.info?.('meeting-minutes: diarize cancelled by user')
        sendJson(res, 200, { ok: true, job: { ...job } })
        return
      }

      if (segments.length === 3 && segments[2] === 'diarize' && (method === 'POST' || method === 'GET')) {
        const meeting = requireMeeting(store, id)
        if (method === 'GET') {
          const job = diarizeJobs.get(id)
          const elapsedSeconds = job !== undefined && typeof job.startedAt === 'number'
            ? Math.max(0, Math.round((Date.now() - job.startedAt) / 1000))
            : 0
          sendJson(res, 200, { ok: true, job: job ? { ...job, elapsedSeconds } : { status: 'idle', stage: 'idle', speakers: 0, elapsedSeconds: 0 } })
          return
        }
        const body = await readJsonBody(req)
        const wanted = Number(body.speakers ?? body.numSpeakers ?? 0)
        const forcedSpeakers = Number.isFinite(wanted) && wanted >= 2 && wanted <= 20 ? Math.round(wanted) : 0
        const requestedMode = body.mode === 'turns' ? 'turns' : 'relabel'
        const audio = (Array.isArray(meeting.media) ? meeting.media : [])
          .find((item) => item && item.kind === 'audio' && typeof item.path === 'string' && existsSync(item.path))
        if (audio === undefined) throw new Error('这场会议没有可用的录音文件，无法重新分离说话人')
        if (deps.paraformer === undefined || deps.paraformer === null
          || deps.paraformer.diarizationAvailable?.() !== true) {
          throw new Error('说话人分离模型未就绪：请到设置 → 模型配置里下载 pyannote 分段与 cam++ 声纹模型')
        }
        const job = startDiarizeJob({ deps, store, meetingId: id, audioPath: audio.path, logger, speakers: forcedSpeakers, mode: requestedMode, reason: 'manual' })
        sendJson(res, 200, { ok: true, job: { ...job, elapsedSeconds: Math.max(0, Math.round((Date.now() - job.startedAt) / 1000)) } })
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
        // **不在这里等 mux/质量分析/声纹分离**：长会议的 MP4 合成要几十秒、分离要十几分钟，
        // 全都放在响应之后后台做，否则「停止会议」会卡很久（历史上甚至阻塞宿主事件循环 10+ 分钟）。
        let pendingMux = null
        if (kind === 'audio' && isCapturing(id) === false) {
          const pendingVideo = takePendingVideo(id)
          if (pendingVideo !== null) {
            const mp4Name = safeMediaName(fileName.replace(/\.wav$/i, '') + '.mp4', '会议录屏.mp4')
            pendingMux = { pendingVideo, mp4Name, mp4Path: join(directory, mp4Name) }
          }
        }
        const kept = previous.filter((item) => item.kind !== kind && (pendingMux === null || item.kind !== 'video'))
        // 先占位一个「转换中」的视频条目，界面据此轮询，合成完成后替换成真实文件。
        const placeholderVideo = pendingMux === null
          ? null
          : { kind: 'video', name: pendingMux.mp4Name, converting: true, seconds: Math.round(seconds), savedAt: new Date().toISOString() }
        const media = [...kept, entry, ...(placeholderVideo === null ? [] : [placeholderVideo])]
        const updated = await store.patch(id, { media })
        // 立即返回：录音已落盘、会议里已能看到这条音频。
        sendJson(res, 200, { ok: true, media: (updated && updated.media) || media, entry, quality: null, postProcessing: true })
        if (pendingMux !== null) {
          void (async () => {
            try {
              const result = await muxScreenWithAudio({ videoPath: pendingMux.pendingVideo.tmpPath, audioPath: target, outPath: pendingMux.mp4Path, logger })
              await dropTempVideo(pendingMux.pendingVideo.tmpPath)
              const currentMedia = Array.isArray(store.get(id)?.media) ? store.get(id).media : media
              if (result.ok === true) {
                const replaced = currentMedia.map((item) => (item?.converting === true && item.kind === 'video'
                  ? {
                    kind: 'video',
                    name: pendingMux.mp4Name,
                    path: pendingMux.mp4Path,
                    bytes: result.bytes,
                    seconds: Math.round(seconds),
                    savedAt: new Date().toISOString(),
                    converted: true,
                  }
                  : item))
                await store.patch(id, { media: replaced })
                logger?.info?.('meeting-minutes: screen video muxed in background (' + String(Math.round(result.bytes / 1048576)) + 'MB)')
              } else {
                const removed = currentMedia.filter((item) => item?.converting !== true)
                await store.patch(id, { media: removed })
                logger?.warn?.('meeting-minutes: 合成录屏视频失败：' + String(result.error ?? '未知原因'))
              }
            } catch (error) {
              logger?.warn?.('meeting-minutes: background mux failed: ' + (error instanceof Error ? error.message : String(error)))
            }
          })()
        }
        if (kind === 'audio') {
          // 质量分析（142MB 要 1.6 秒 CPU）：放到响应之后，避免拖慢停止。
          void (async () => {
            try {
              const analyzed = analyzeWavQuality(bytes)
              if (analyzed !== null) await store.patch(id, { audioQuality: { ...analyzed, analyzedAt: new Date().toISOString() } })
            } catch (error) {
              logger?.warn?.('meeting-minutes: audio quality analysis failed: ' + (error instanceof Error ? error.message : String(error)))
            }
          })()
          // 说话人分离：走独立子进程（不再用同步的 transcribeFileWithSpeakers，长会议会把宿主卡住十分钟）。
          void (async () => {
            try {
              const settingsNow = store.settings
              if (settingsNow.diarize === true && deps.paraformer !== undefined && deps.paraformer !== null && deps.paraformer.diarizationAvailable() === true) {
                startDiarizeJob({ deps, store, meetingId: id, audioPath: target, logger, mode: 'relabel', reason: 'auto' })
                logger?.info?.('meeting-minutes: auto diarization started in background')
              }
            } catch (error) {
              logger?.warn?.('meeting-minutes: auto diarization start failed: ' + (error instanceof Error ? error.message : String(error)))
            }
          })()
          // 转写纠错（LLM 调用本身是异步的，不会卡宿主）。
          void (async () => {
            try {
              const settingsNow = store.settings
              if (settingsNow.correctTranscript === true) {
                const current = requireMeeting(store, id)
                if (typeof current.transcript === 'string' && current.transcript.trim() !== '') {
                  const correctionContext = buildCorrectionContext(store.snapshot().meetings, current)
                  const corrected = await summarizer.correctTranscript(current, {
                    selection: store.summaryModel,
                    terms: effectiveTerms(settingsNow),
                    notes: effectiveCorrectionNotes(settingsNow),
                    style: settingsNow.transcriptStyle,
                    context: correctionContext,
                    custom: settingsNow.summary.mode === 'custom' ? settingsNow.summary.custom : null,
                  })
                  if (settingsNow.reviewCorrections !== false) {
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
              logger?.warn?.('meeting-minutes: transcript correction failed: ' + (error instanceof Error ? error.message : String(error)))
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
        const revealed = await revealMediaPath(entry.path)
        // 每次请求都留痕：下次「点了没反应」时能直接区分「请求没到」还是「系统没打开」。
        logger?.info?.('meeting-minutes: reveal media -> ' + (revealed === true ? 'launched' : 'failed') + ' (' + String(entry.path ?? '') + ')')
        sendJson(res, 200, { ok: true, path: entry.path, revealed })
        return
      }

      if (segments.length === 4 && segments[2] === 'media' && segments[3] === 'open' && method === 'POST') {
        const meeting = requireMeeting(store, id)
        const body = await readJsonBody(req)
        const kind = String(body.kind ?? '')
        const entry = (Array.isArray(meeting.media) ? meeting.media : []).find((item) => item && item.kind === kind)
        if (entry === undefined) throw new Error('这场会议还没有生成该类型的文件')
        const opened = await openMediaPath(entry.path)
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

