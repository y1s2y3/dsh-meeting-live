/**
 * Host-side mirror of the browser's live-recording state, plus a one-slot
 * command queue for the desktop orb.
 *
 * The browser half owns the microphone and the audio pipeline; it pushes a
 * heartbeat (`POST /dsh-meeting/live/status`) about once per second. This module
 * keeps the latest snapshot so the orb can render without touching the browser,
 * and it stores commands the orb sends back until the next heartbeat picks them
 * up.
 *
 * @module dsh-plugin-meeting-minutes/live-mirror
 */

/** Statuses that mean "a recording session is live". */
const ACTIVE_STATUSES = new Set(['preparing', 'recording', 'paused', 'stopping'])

/** Lifecycle statuses that end a session. */
const TERMINAL_STATUSES = new Set(['idle', 'done', 'error'])

/** Create the mirror used by the HTTP route and the orb bridge. */
export function createLiveMirror() {
  let status = 'idle'
  let meetingId = null
  let title = ''
  let elapsedSeconds = 0
  /** When the browser last reported its timer, used to tick between heartbeats. */
  let elapsedAt = 0
  let chars = 0
  let lastText = ''
  /** 0..1 的实时音量（麦克风电平），用于浮球的说话动效。 */
  let level = 0
  let updatedAt = Date.now()
  /** Only the newest command matters: an older pause must not fire after a stop. */
  let pendingCommand = null

  const listeners = new Set()

  function emit() {
    updatedAt = Date.now()
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // A broken listener must not break the recording bridge.
      }
    }
  }

  return {
    /** Merge one heartbeat payload; unknown fields are ignored. */
    setStatus(payload = {}) {
      if (typeof payload !== 'object' || payload === null) return
      if (typeof payload.status === 'string' && payload.status !== '') status = payload.status
      if (typeof payload.meetingId === 'string' && payload.meetingId !== '') meetingId = payload.meetingId
      if (payload.meetingId === null) meetingId = null
      if (typeof payload.title === 'string') title = payload.title
      if (Number.isFinite(Number(payload.elapsedSeconds))) {
        elapsedSeconds = Math.max(0, Math.round(Number(payload.elapsedSeconds)))
        elapsedAt = Date.now()
      }
      if (Number.isFinite(Number(payload.chars))) chars = Math.max(0, Math.round(Number(payload.chars)))
      if (typeof payload.lastText === 'string') lastText = payload.lastText
      if (Number.isFinite(Number(payload.level))) {
        level = Math.min(1, Math.max(0, Number(payload.level)))
      }
      if (TERMINAL_STATUSES.has(status)) {
        if (status === 'idle') {
          meetingId = null
          title = ''
          elapsedSeconds = 0
          elapsedAt = 0
          chars = 0
          lastText = ''
          level = 0
        }
        // A finished session never keeps an unclaimed command.
        pendingCommand = null
      }
      emit()
    },

    /** Queue a command from the orb; the browser drains it on its next heartbeat. */
    queueCommand(command) {
      if (command !== 'pause' && command !== 'resume' && command !== 'stop') return false
      pendingCommand = command
      return true
    },

    /** Read and clear the pending command. */
    takeCommand() {
      const command = pendingCommand
      pendingCommand = null
      return command
    },

    /** Current snapshot for the orb, with the timer ticked forward between heartbeats. */
    snapshot() {
      const ticking = status === 'recording' && elapsedAt > 0
      const extra = ticking ? Math.max(0, Math.round((Date.now() - elapsedAt) / 1000)) : 0
      return {
        status,
        meetingId,
        title,
        elapsedSeconds: elapsedSeconds + extra,
        chars,
        lastText,
        level,
        updatedAt,
      }
    },

    /** Whether a recording session is live (the orb should exist). */
    isActive() {
      return ACTIVE_STATUSES.has(status)
    },

    /** Subscribe to snapshot changes; returns the disposer. */
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
