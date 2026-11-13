/**
 * 宿主侧屏幕录制（Windows / ffmpeg gdigrab）。
 *
 * 背景：DSH Desktop 是 Electron 应用，但**没有实现** `setDisplayMediaRequestHandler`，
 * 浏览器里的 `navigator.mediaDevices.getDisplayMedia` 既不会弹选择器也拿不到画面。
 * 因此录屏改由宿主进程调用本机 ffmpeg 的 gdigrab 设备完成，会议结束后再与音频 WAV
 * 合成 MP4（视频直接 copy，音频转 AAC）。
 *
 * 对外接口（供 server.js 使用）：
 *   listScreenSources()            列出显示器（含主屏标记）
 *   startScreenCapture({...})      启动录制，返回 { ok, session }
 *   stopScreenCapture(meetingId)   停止录制并返回临时视频路径（等待 ffmpeg 收尾）
 *   takePendingVideo(meetingId)    取出待合成的录屏（供音频上传后合成）
 *   muxScreenWithAudio({...})      录屏 + WAV → MP4
 *   isCapturing(meetingId)
 *
 * 所有 ffmpeg 进程都通过 stdin 发 'q' 优雅退出（这样 mkv 才能正常收尾）。
 */
import { spawn, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'

/** 正在录制的会话：meetingId → { child, tmpPath, source, startedAt } */
const sessions = new Map()
/** 已停止、等待与音频合成的录屏：meetingId → { tmpPath, seconds } */
const pending = new Map()

const IS_WINDOWS = process.platform === 'win32'

/** 缓存 ffmpeg 路径：环境变量优先，其次 PATH，再找 winget / 常见安装目录。 */
let ffmpegPathCache = null
let ffmpegProbed = false

export function findFfmpeg() {
  if (ffmpegProbed) return ffmpegPathCache
  ffmpegProbed = true
  const candidates = []
  if (process.env.FFMPEG_PATH !== undefined && process.env.FFMPEG_PATH !== '') candidates.push(process.env.FFMPEG_PATH)
  const localAppData = process.env.LOCALAPPDATA ?? ''
  candidates.push('ffmpeg')
  if (localAppData !== '') {
    candidates.push(join(localAppData, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'))
    const packages = join(localAppData, 'Microsoft', 'WinGet', 'Packages')
    try {
      for (const name of readdirSync(packages)) {
        if (!String(name).toLowerCase().includes('ffmpeg')) continue
        const root = join(packages, name)
        const stack = [root]
        while (stack.length > 0) {
          const current = stack.pop()
          let entries = []
          try {
            entries = readdirSync(current, { withFileTypes: true })
          } catch {
            continue
          }
          for (const entry of entries) {
            const full = join(current, entry.name)
            if (entry.isFile() && entry.name.toLowerCase() === 'ffmpeg.exe') {
              candidates.push(full)
              continue
            }
            if (entry.isDirectory() && current.split(sep).length < root.split(sep).length + 4) stack.push(full)
          }
        }
      }
    } catch {
      // 没装 winget 版本就继续试其它路径
    }
  }
  candidates.push('C:/ffmpeg/bin/ffmpeg.exe', 'C:/Program Files/ffmpeg/bin/ffmpeg.exe')
  for (const candidate of candidates) {
    try {
      if (candidate !== 'ffmpeg' && !existsSync(candidate)) continue
      ffmpegPathCache = candidate
      return candidate
    } catch {
      // 下一个候选
    }
  }
  ffmpegPathCache = null
  return null
}

/** 录制文件目录：<dsh-home>/storages/meeting-minutes-media/<meetingId>/ */
function mediaRoot() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'meeting-minutes-media')
}

/** 用 PowerShell 枚举显示器（gdigrab 需要左上角坐标 + 尺寸）。 */
function listDisplaysWithPowerShell() {
  if (!IS_WINDOWS) return Promise.resolve([])
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { ',
    '  "$($_.DeviceName)|$($_.Bounds.X)|$($_.Bounds.Y)|$($_.Bounds.Width)|$($_.Bounds.Height)|$($_.Primary)"',
    '}',
  ].join('; ')
  return new Promise((resolve) => {
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
        if (error !== null) {
          resolve([])
          return
        }
        const lines = String(stdout ?? '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line !== '')
        const screens = []
        for (const line of lines) {
          const parts = line.split('|')
          if (parts.length < 6) continue
          const x = Number(parts[1])
          const y = Number(parts[2])
          const width = Number(parts[3])
          const height = Number(parts[4])
          if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue
          screens.push({
            id: 'screen:' + String(screens.length),
            label: '显示器 ' + String(screens.length + 1) + '（' + width + '×' + height + (parts[5] === 'True' ? '，主屏' : '') + '）',
            kind: 'screen',
            x,
            y,
            width,
            height,
          })
        }
        resolve(screens)
      },
    )
    } catch {
      resolve([])
    }
  })
}

/** 列出可选的录屏画面：各显示器 + 整个桌面。 */
export async function listScreenSources() {
  if (process.env.DSH_MEETING_NO_SCREEN === '1') {
    return [{ id: 'desktop', label: '整个桌面（测试模式）', kind: 'desktop' }]
  }
  if (!IS_WINDOWS) return [{ id: 'desktop', label: '整个桌面', kind: 'desktop' }]
  const screens = await listDisplaysWithPowerShell()
  const totalWidth = screens.reduce((sum, screen) => Math.max(sum, Number(screen.x) + Number(screen.width)), 0)
  const totalHeight = screens.reduce((sum, screen) => Math.max(sum, Number(screen.y) + Number(screen.height)), 0)
  const sources = [
    { id: 'desktop', label: '整个桌面（所有显示器' + (totalWidth > 0 ? ' ' + String(totalWidth) + '×' + String(totalHeight) : '') + '）', kind: 'desktop' },
    ...screens,
  ]
  return sources
}

/** 找到某个源的采集区域；找不到返回 null（用整桌面）。 */
function resolveRegion(sourceId) {
  if (typeof sourceId !== 'string' || sourceId === '' || sourceId === 'desktop') return null
  // 显示器数量很少，直接再枚举一次最稳（PowerShell 200ms 级别）
  return { sourceId }
}

/** ffmpeg 录屏参数：gdigrab 抓整个桌面或指定区域，缩放保证宽高为偶数。 */
function captureArgs({ region, outPath }) {
  const args = ['-y', '-loglevel', 'error', '-f', 'gdigrab', '-framerate', '15']
  if (region !== null && region !== undefined) {
    args.push('-offset_x', String(region.x), '-offset_y', String(region.y), '-video_size', String(region.width) + 'x' + String(region.height))
  }
  args.push('-i', 'desktop')
  args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2')
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p', '-g', '30')
  args.push(outPath)
  return args
}

/**
 * 开始录屏。
 * @param options - `{ meetingId, source }`，`source` 为 listScreenSources 的 id。
 * @returns `{ ok, error?, label? }`。
 */
export async function startScreenCapture({ meetingId, source, logger } = {}) {
  if (typeof meetingId !== 'string' || meetingId === '') return { ok: false, error: '缺少会议 ID' }
  if (sessions.has(meetingId)) return { ok: true, label: sessions.get(meetingId).label }
  if (process.env.DSH_MEETING_NO_SCREEN === '1') {
    const fakePath = join(mediaRoot(), meetingId, 'screen-fake.mkv')
    sessions.set(meetingId, { child: null, tmpPath: fakePath, label: '测试模式', source: source ?? 'desktop', startedAt: Date.now() })
    return { ok: true, label: '测试模式' }
  }
  if (!IS_WINDOWS) return { ok: false, error: '录屏目前只支持 Windows' }
  const ffmpeg = findFfmpeg()
  if (ffmpeg === null) return { ok: false, error: '没有找到 ffmpeg，无法录屏（安装：winget install Gyan.FFmpeg）' }

  const sources = await listScreenSources()
  const chosen = sources.find((item) => item.id === source) ?? sources[0]
  const region = chosen !== undefined && chosen.kind === 'screen' ? chosen : null
  const directory = join(mediaRoot(), meetingId)
  await mkdir(directory, { recursive: true })
  const tmpPath = join(directory, 'screen-' + String(Date.now()) + '.mkv')
  const child = spawn(ffmpeg, captureArgs({ region, outPath: tmpPath }), { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
  let stderrTail = ''
  if (child.stderr !== null) {
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-2000)
    })
  }
  const failed = await new Promise((resolve) => {
    child.once('error', (error) => resolve(String(error?.message ?? error)))
    child.once('exit', (code) => resolve(code === 0 || code === null ? null : '录屏进程退出（code=' + String(code) + '）' + stderrTail))
    setTimeout(() => resolve(null), 900)
  })
  if (failed !== null) {
    try { child.kill() } catch { }
    return { ok: false, error: failed }
  }
  sessions.set(meetingId, { child, tmpPath, label: chosen?.label ?? '整个桌面', source: chosen?.id ?? 'desktop', startedAt: Date.now() })
  logger?.info?.('meeting-minutes: screen capture started (' + String(chosen?.label ?? '整个桌面') + ')')
  return { ok: true, label: chosen?.label ?? '整个桌面' }
}

/** 停止录屏：向 ffmpeg 发 'q' 让它正常收尾，返回临时视频信息。 */
export async function stopScreenCapture(meetingId, logger) {
  const session = sessions.get(meetingId)
  if (session === undefined) return { ok: false, error: '当前没有在进行录屏' }
  sessions.delete(meetingId)
  const seconds = Math.max(0, Math.round((Date.now() - session.startedAt) / 1000))
  if (session.child === null) {
    pending.set(meetingId, { tmpPath: session.tmpPath, seconds })
    return { ok: true, videoPath: session.tmpPath, seconds }
  }
  const child = session.child
  const finished = new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill() } catch { }
      resolve()
    }, 15000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  try {
    child.stdin.write('q\n')
  } catch {
    try { child.kill() } catch { }
  }
  await finished
  const exists = existsSync(session.tmpPath)
  if (!exists) return { ok: false, error: '录屏文件没有生成（可能是采集被系统拒绝）' }
  pending.set(meetingId, { tmpPath: session.tmpPath, seconds })
  logger?.info?.('meeting-minutes: screen capture stopped (' + String(seconds) + 's)')
  return { ok: true, videoPath: session.tmpPath, seconds }
}

/** 取出并消费待合成的录屏。 */
export function takePendingVideo(meetingId) {
  const item = pending.get(meetingId)
  if (item === undefined) return null
  pending.delete(meetingId)
  return item
}

export function isCapturing(meetingId) {
  return sessions.has(meetingId)
}

/** 录屏（h264 mkv）+ 音频（wav）→ MP4（视频直接 copy，音频转 AAC）。 */
export async function muxScreenWithAudio({ videoPath, audioPath, outPath, logger } = {}) {
  if (process.env.DSH_MEETING_NO_SCREEN === '1') {
    return { ok: false, error: '测试模式不合成视频' }
  }
  const ffmpeg = findFfmpeg()
  if (ffmpeg === null) return { ok: false, error: '没有找到 ffmpeg，无法合成视频' }
  if (!existsSync(videoPath)) return { ok: false, error: '录屏文件不存在' }
  const args = ['-y', '-loglevel', 'error', '-i', videoPath]
  const hasAudio = typeof audioPath === 'string' && audioPath !== '' && existsSync(audioPath)
  if (hasAudio) args.push('-i', audioPath)
  args.push('-map', '0:v:0')
  if (hasAudio) args.push('-map', '1:a:0')
  args.push('-c:v', 'copy')
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '128k', '-shortest')
  args.push('-movflags', '+faststart', outPath)
  const result = await new Promise((resolve) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' })
    child.once('error', (error) => resolve({ ok: false, error: String(error?.message ?? error) }))
    child.once('exit', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: 'ffmpeg 合成失败（code=' + String(code) + '）' }))
  })
  if (result.ok !== true) return result
  try {
    const info = await stat(outPath)
    logger?.info?.('meeting-minutes: screen video muxed (' + String(Math.round(info.size / 1024 / 1024)) + 'MB)')
    return { ok: true, bytes: info.size }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** 屏幕提示的渲染日志（排查"点了没看到"时看这里）。 */
export function markerLogPath() {
  return join(dirname(mediaRoot()), 'meeting-minutes-marker.log')
}

/** 屏幕提示脚本路径（resources/screen-marker.ps1）。 */
function markerScriptPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'screen-marker.ps1')
}

let markerChild = null

/**
 * 在被选中的屏幕上短暂显示「当前录制屏幕」提示（约 2 秒自动消失）。
 * @param screenId - listScreenSources 返回的 id（screen:N 或 desktop）。
 * @returns `{ ok, label?, bounds?, error? }`。
 */
export async function identifyScreen(screenId, logger) {
  if (process.env.DSH_MEETING_NO_SCREEN === '1') {
    return { ok: true, label: '测试模式', bounds: { x: 0, y: 0, width: 1280, height: 800 } }
  }
  if (!IS_WINDOWS) return { ok: false, error: '屏幕识别目前只支持 Windows' }
  const sources = await listScreenSources()
  const screens = sources.filter((item) => item.kind === 'screen')
  if (screens.length === 0) return { ok: false, error: '没有检测到可提示的显示器' }
  const picked = screens.find((item) => item.id === screenId)
  let bounds
  let label
  if (picked !== undefined) {
    bounds = { x: picked.x, y: picked.y, width: picked.width, height: picked.height }
    label = picked.label
  } else {
    const minX = Math.min(...screens.map((item) => item.x))
    const minY = Math.min(...screens.map((item) => item.y))
    const maxX = Math.max(...screens.map((item) => item.x + item.width))
    const maxY = Math.max(...screens.map((item) => item.y + item.height))
    bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    label = '整个桌面'
  }
  const script = markerScriptPath()
  if (!existsSync(script)) return { ok: false, error: '缺少屏幕提示脚本（resources/screen-marker.ps1）' }
  if (markerChild !== null) {
    try { markerChild.kill() } catch { }
    markerChild = null
  }
  const powershell = process.env.SystemRoot === undefined
    ? 'powershell.exe'
    : join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const child = spawn(powershell, [
    '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-X', String(Math.round(bounds.x)), '-Y', String(Math.round(bounds.y)),
    '-W', String(Math.round(bounds.width)), '-H', String(Math.round(bounds.height)),
    '-Title', '当前录制屏幕',
    '-Hint', label + ' · 录屏范围已锁定，3 秒后自动隐藏',
    '-HoldMs', '3000',
    '-LogFile', markerLogPath(),
  ], { stdio: 'ignore', windowsHide: true })
  markerChild = child
  child.once('exit', () => { if (markerChild === child) markerChild = null })
  logger?.info?.('meeting-minutes: screen identify marker on ' + label + ' (log: ' + markerLogPath() + ')')
  return { ok: true, bounds, label, logPath: markerLogPath() }
}

/** 清理临时录屏文件（合成成功或失败后都调用）。 */
export async function dropTempVideo(videoPath) {
  try {
    await rm(videoPath, { force: true })
  } catch {
    // 删不掉不影响主流程
  }
}

/** 会议被删除 / 插件卸载时收尾。 */
export async function disposeScreenRecorder() {
  for (const [meetingId, session] of sessions) {
    sessions.delete(meetingId)
    if (session.child !== null) {
      try { session.child.stdin.write('q\n') } catch { }
      try { session.child.kill() } catch { }
    }
  }
  pending.clear()
}

export function screenRecorderStatus() {
  return {
    ffmpeg: findFfmpeg(),
    platform: process.platform,
    capturing: [...sessions.keys()],
    pending: [...pending.keys()],
  }
}

export { mediaRoot as screenMediaRoot, dirname as screenDirname }
