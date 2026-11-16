/**
 * Desktop orb (always-on-top WPF widget) manager + its bridge to the live mirror.
 *
 * Windows only: the widget is a Windows PowerShell STA process rendering WPF.
 * On every other platform `supported` is false and the browser keeps using the
 * in-page recording bar.
 *
 * Protocol (file based, no ports, no credentials):
 *   - host -> orb : `<stateDir>\state-<NNNNNN>.json`, newest number wins
 *   - orb -> host : `<stateDir>\cmd-<ticks>-<rand>.json`, drained every 250 ms
 *   - `<stateDir>\pos.json` remembers where the user parked the widget
 *
 * The orb also exits on its own after 30 s without a state refresh, so a crashed
 * or force-killed host cannot leave an orphan widget on screen.
 *
 * @module dsh-meeting-live/orb
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ORB_DIR_NAME = 'dsh-meeting-orb'
const SCRIPT_NAME = 'meeting-orb.ps1'
const POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe'
/** How long the finished state stays on screen before the widget goes away. */
const CLOSE_GRACE_MS = 1200
/** How long to wait for the widget to close itself before force-killing it. */
const KILL_GRACE_MS = 2500

/** Labels the widget renders; Chinese lives here (the script stays ASCII). */
const ORB_LABELS = {
  recording: '录音中',
  paused: '已暂停',
  preparing: '正在准备…',
  stopping: '正在收尾…',
  stoppingAction: '停止中…',
  done: '已停止',
  error: '出错了',
  idle: '空闲',
  pause: '暂停',
  resume: '继续',
  stop: '停止',
  chars: '已转写 {0} 字',
  inputDevice: '输入设备',
  hintStop: '点「停止」结束录音，并自动跳回会议纪要',
}

/** Locate the packaged widget script next to this module. */
function resolveScriptPath() {
  const here = fileURLToPath(new URL('.', import.meta.url))
  return path.join(here, '..', 'resources', SCRIPT_NAME)
}

/**
 * Create the orb manager.
 * @param options - `{ logger, profileKey }`.
 */
export function createOrbManager({ logger, profileKey = process.env.DSH_PROFILE ?? 'desktop' } = {}) {
  const scriptPath = resolveScriptPath()
  const stateDir = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), ORB_DIR_NAME, profileKey)
  const supported = process.platform === 'win32' && fs.existsSync(scriptPath)

  let child = null
  let seq = 0
  let lastState = null
  let lastError = null

  function ensureDir() {
    fs.mkdirSync(stateDir, { recursive: true })
  }

  /** Remove protocol leftovers so a stale `close`/command cannot leak between runs. */
  function clearProtocolFiles() {
    try {
      for (const name of fs.readdirSync(stateDir)) {
        if (name.startsWith('state-') || name.startsWith('cmd-') || name === 'orb.pid') {
          fs.rmSync(path.join(stateDir, name), { force: true })
        }
      }
    } catch {
      // A leftover file only costs one stale frame.
    }
  }

  /** Kill a widget left behind by an earlier host process. */
  function killStaleWidget() {
    try {
      const pidFile = path.join(stateDir, 'orb.pid')
      if (!fs.existsSync(pidFile)) return
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
      if (Number.isFinite(pid) && pid > 0) {
        process.kill(pid)
        logger?.info?.(`meeting-minutes: orb: stopped stale widget pid ${pid}`)
      }
    } catch {
      // Already gone.
    } finally {
      try {
        fs.rmSync(path.join(stateDir, 'orb.pid'), { force: true })
      } catch {
        // Ignore.
      }
    }
  }

  function writeState(payload) {
    if (child === null) return
    try {
      ensureDir()
      seq += 1
      const name = `state-${String(seq).padStart(6, '0')}.json`
      const target = path.join(stateDir, name)
      const temporary = `${target}.tmp`
      lastState = { ...payload, updatedAt: Date.now() }
      fs.writeFileSync(temporary, JSON.stringify(lastState), 'utf8')
      fs.renameSync(temporary, target)
      for (const old of fs.readdirSync(stateDir)) {
        if (!old.startsWith('state-') || !old.endsWith('.json') || old === name) continue
        const index = Number(old.slice('state-'.length, 'state-'.length + 6))
        if (Number.isFinite(index) && seq - index > 3) fs.rmSync(path.join(stateDir, old), { force: true })
      }
    } catch (error) {
      logger?.warn?.(`meeting-minutes: orb: state write failed: ${error?.message ?? error}`)
    }
  }

  /** Drain the command files the widget wrote. */
  function drainCommands() {
    const commands = []
    try {
      if (!fs.existsSync(stateDir)) return commands
      for (const name of fs.readdirSync(stateDir)) {
        if (!name.startsWith('cmd-') || !name.endsWith('.json')) continue
        const full = path.join(stateDir, name)
        try {
          const parsed = JSON.parse(fs.readFileSync(full, 'utf8'))
          if (parsed && typeof parsed.command === 'string') {
            // 切换输入设备：把 deviceId 编进同一条命令串，浏览器侧按前缀解析。
            if (parsed.command === 'switch-input' && typeof parsed.deviceId === 'string' && parsed.deviceId !== '') {
              commands.push(`switch-input:${parsed.deviceId}`)
            } else {
              commands.push(parsed.command)
            }
          }
        } catch {
          // A half-written command is dropped.
        }
        try {
          fs.rmSync(full, { force: true })
        } catch {
          // Ignore.
        }
      }
    } catch {
      // A missing directory means no widget is running.
    }
    return commands
  }

  function start() {
    if (!supported || child !== null) return false
    ensureDir()
    killStaleWidget()
    clearProtocolFiles()
    seq = 0
    try {
      const logPath = path.join(stateDir, 'orb.log')
      const log = fs.openSync(logPath, 'a')
      child = spawn(POWERSHELL, [
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-StateDir', stateDir,
        '-PidFile', path.join(stateDir, 'orb.pid'),
      ], {
        windowsHide: true,
        stdio: ['ignore', log, log],
      })
      child.on('exit', (code, signal) => {
        logger?.info?.(`meeting-minutes: orb exited (code=${code}${signal ? `, signal=${signal}` : ''})`)
        child = null
      })
      child.on('error', (error) => {
        lastError = error
        logger?.warn?.(`meeting-minutes: orb spawn failed: ${error?.message ?? error}`)
        child = null
      })
      logger?.info?.(`meeting-minutes: desktop orb started (${stateDir})`)
      return true
    } catch (error) {
      lastError = error
      child = null
      logger?.warn?.(`meeting-minutes: orb spawn threw: ${error?.message ?? error}`)
      return false
    }
  }

  /**
   * Ask the widget to disappear (it closes itself), with a force kill as fallback.
   * @param finalState - the last frame to show (status done/error).
   */
  function stop(finalState) {
    if (child === null) return
    writeState({ ...(finalState ?? lastState ?? {}), close: true })
    const process_ = child
    child = null
    setTimeout(() => {
      try {
        process_.kill()
      } catch {
        // Already exited.
      }
    }, KILL_GRACE_MS).unref?.()
  }

  return {
    get supported() {
      return supported
    },
    get running() {
      return child !== null
    },
    get lastError() {
      return lastError
    },
    get stateDir() {
      return stateDir
    },
    labels: ORB_LABELS,
    start,
    stop,
    publish: (state) => writeState(state),
    drainCommands,
  }
}

/**
 * Wire the live mirror to the orb: start/stop the widget with the session, push
 * a frame on change, and forward the widget's buttons back to the browser.
 *
 * @param options - `{ liveMirror, orb, store, logger }`.
 * @returns the disposer that stops timers and the widget.
 */
export function startOrbBridge({ liveMirror, orb, store, logger } = {}) {
  if (!liveMirror || !orb || !orb.supported) {
    logger?.info?.('meeting-minutes: desktop orb unavailable; using the in-page recording bar')
    return () => {}
  }

  let wasActive = false
  let lastFrameKey = ''
  let closeTimer = null

  const commandTimer = setInterval(() => {
    for (const command of orb.drainCommands()) {
      if (liveMirror.queueCommand(command)) {
        logger?.info?.(`meeting-minutes: orb command "${command}" queued`)
      }
    }
  }, 250)

  function transcriptFor(meetingId) {
    if (!meetingId) return ''
    try {
      const meeting = store.get(meetingId)
      const transcript = typeof meeting?.transcript === 'string' ? meeting.transcript : ''
      // The widget only needs the tail; a 1 MB state file would slow it down.
      return transcript.length > 6000 ? transcript.slice(-6000) : transcript
    } catch {
      return ''
    }
  }

  function frame(snapshot, extra = {}) {
    return {
      v: 1,
      status: snapshot.status,
      title: snapshot.title || '会议纪要',
      meetingId: snapshot.meetingId,
      elapsedSeconds: snapshot.elapsedSeconds,
      chars: snapshot.chars,
      lastText: snapshot.lastText,
      level: Number.isFinite(snapshot.level) ? snapshot.level : 0,
      devices: Array.isArray(snapshot.devices) ? snapshot.devices : [],
      deviceId: typeof snapshot.deviceId === 'string' ? snapshot.deviceId : '',
      transcript: transcriptFor(snapshot.meetingId),
      labels: ORB_LABELS,
      ...extra,
    }
  }

  const stateTimer = setInterval(() => {
    const snapshot = liveMirror.snapshot()
    // 浏览器心跳断了（页面关闭 / 崩溃 / 停止时终态心跳丢失）也算会话结束：
    // 20 秒没有新心跳就收掉浮窗，避免记完的球一直挂在那儿。
    const stale = snapshot.updatedAt > 0 && Date.now() - snapshot.updatedAt > 20000
    const active = liveMirror.isActive() && !stale

    if (active && !wasActive) {
      if (closeTimer !== null) {
        clearTimeout(closeTimer)
        closeTimer = null
      }
      if (!orb.running) orb.start()
      lastFrameKey = ''
    }

    if (active) {
      // 浮窗进程可能被杀掉 / 崩溃；录音还在就把它重新拉起来。
      if (!orb.running) orb.start()
      const payload = frame(snapshot)
      const key = JSON.stringify(payload)
      if (key !== lastFrameKey) {
        orb.publish(payload)
        lastFrameKey = key
      }
      wasActive = true
      return
    }

    if (wasActive) {
      wasActive = false
      // Show the final frame briefly, then let the widget close itself.
      orb.publish(frame(snapshot, { close: false }))
      closeTimer = setTimeout(() => {
        closeTimer = null
        orb.stop(frame(snapshot, { close: true }))
      }, CLOSE_GRACE_MS)
    }
  }, 500)

  return () => {
    clearInterval(commandTimer)
    clearInterval(stateTimer)
    if (closeTimer !== null) clearTimeout(closeTimer)
    orb.stop()
  }
}
