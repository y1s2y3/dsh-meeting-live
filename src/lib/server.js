/**
 * Local HTTP surface for the meeting-minutes plugin's browser half.
 *
 * The panel is a hand-written client bundle: it cannot use the generated Typert
 * Remote channel (that assembly is fixed at build time), so the host half claims
 * one prefix route on `ctx.webServer` and the bundle talks to it with plain
 * `fetch`. Everything is loopback-only, same-origin, and JSON in/JSON out — the
 * transcription route is the single binary exception (canonical 16kHz WAV).
 *
 * @module dsh-plugin-meeting-minutes/server
 */

import { formatMoment, isGenericTitle, localDay, projectMeeting, todoProgress } from './model.js'
import { sortMeetings } from './store.js'
import { exportMeeting } from './export.js'
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
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { spawn } from 'node:child_process'

/** Registered prefix; the client builds its URLs from the same constant. */
export const ROUTE_PREFIX = '/dsh-meeting'

/** JSON response helper. */
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
  return new Uint8Array(Buffer.concat(chunks))
}

/** Only the loopback interface may reach these routes. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Build the `/state` payload the panel renders. */
export async function buildState(deps) {
  const { store, asr, summarizer, calendar, autoIngest } = deps
  await store.load()
  const [speech, calendarStatus] = await Promise.all([
    Promise.resolve().then(() => asr.status()),
        deps.dshTodo !== undefined ? deps.dshTodo.describe(calendar) : calendar.status(),
  ])
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
        sendJson(res, 200, { ok: true, plugin: 'dsh-plugin-meeting-minutes', file: store.file })
        return
      }

      if (segments.length === 1 && segments[0] === 'state' && method === 'GET') {
        sendJson(res, 200, await buildState(deps))
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

      if (segments.length === 2 && segments[0] === 'auto-ingest' && segments[1] === 'status' && method === 'GET') {
        sendJson(res, 200, { ok: true, autoIngest: autoIngest === undefined ? null : autoIngest.status() })
        return
      }

      if (segments.length === 2 && segments[0] === 'auto-ingest' && segments[1] === 'scan' && method === 'POST') {
        if (autoIngest === undefined) throw new Error('自动入库不可用')
        void autoIngest.scanNow().catch((error) => logger?.warn?.(error))
        sendJson(res, 200, { ok: true, autoIngest: autoIngest.status() })
        return
      }

      if (segments.length === 1 && segments[0] === 'auto-ingest' && method === 'POST') {
        if (autoIngest === undefined) throw new Error('自动入库不可用')
        const body = await readJsonBody(req)
        const autoIngestStatus = await autoIngest.setConfig({
          ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
          ...(body.tencent === undefined ? {} : { tencent: body.tencent }),
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
        sendJson(res, 200, {
          ok: true,
          model: store.summaryModel,
          defaultModel,
          models: models.filter((item) => item.id !== ''),
        })
        return
      }

      if (segments.length === 1 && segments[0] === 'settings' && (method === 'PATCH' || method === 'POST')) {
        const body = await readJsonBody(req)
        if (body.model !== undefined) {
          await store.setSummaryModel(body.model)
        }
        sendJson(res, 200, { ok: true, model: store.summaryModel })
        return
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

      if (segments.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, { ok: true, meeting: requireMeeting(store, id) })
          return
        }
        if (method === 'PATCH' || method === 'POST') {
          requireMeeting(store, id)
          const body = await readJsonBody(req)
          const patch = {}
          for (const key of ['title', 'date', 'attendees', 'transcript', 'transcriptSegments', 'notes', 'sourceType', 'transcriptSeconds', 'media']) {
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
        const summary = await summarizer.summarize(meeting, { selection: store.summaryModel })
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
        let result
        try {
          result = await asr.transcribeWav(bytes, { language, providerId })
        } catch (error) {
          // 实时转写是每 5 秒切一片滚动送识别的；某一片里没有可识别语音
          // （静音、环境噪声、说话太轻、刚点录音还没开口）属于正常现象，
          // 上游把它当致命错误会让整场录音当场中断，这里降级成空结果继续。
          if (!(error instanceof Error) || error.message !== '语音识别没有识别出任何文字') {
            // 真故障写进宿主日志，便于事后定位（原插件在这里静默抛出）。
            logger?.warn?.(`meeting-minutes: transcribe failed: ${error instanceof Error ? error.message : String(error)}`)
            throw error
          }
          const audioSeconds = Math.max(0, (bytes.length - 44) / (16000 * 2))
          logger?.info?.(`meeting-minutes: chunk had no speech (${audioSeconds.toFixed(1)}s); keeping the session`)
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
          const targets = (meeting.todos ?? []).filter((todo) => wanted === null || wanted.has(todo.id))
          for (const todo of targets) {
            const title = String(todo.title ?? '').trim()
            if (title === '') continue
            const owner = String(todo.owner ?? '').trim()
            const text = owner === '' ? title : `${title}（负责人：${owner}）`
            const added = dshTodo.add(text, {
              due: typeof todo.due === 'string' && todo.due !== '' ? todo.due : undefined,
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
        const updated = await store.patch(id, { media })
        sendJson(res, 200, { ok: true, media: (updated && updated.media) || media, entry: stored })
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
