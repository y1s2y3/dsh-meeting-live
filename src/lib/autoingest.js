/**
 * Automatic meeting ingest.
 *
 * Two local sources are watched, both read-only and opt-out:
 *
 * 1. **Tencent Meeting local recordings.** The macOS client keeps one SQLite
 *    table (`local_record_data`) describing every locally recorded meeting:
 *    title, meeting code, recording path, and end time. This module locates the
 *    table, and once a recording is complete and still on disk it transcribes
 *    the audio with the same local SenseVoice pipeline and stores the meeting
 *    ("待整理"), so nothing has to be exported by hand.
 * 2. **User-chosen folders.** New audio/video files, plain text/Markdown, and
 *    exported `.docx` minutes dropped into a configured directory are imported
 *    the same way (audio → transcript, text → meeting text).
 *
 * Cloud-side Tencent "智能纪要" has no personal API; without an enterprise
 * credential the reliable local path is the recording (or an exported file).
 * Everything here is persisted through the store, deduplicated by source key,
 * and retried at most three times per source.
 *
 * @module dsh-meeting-live/autoingest
 */

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, sep } from 'node:path'
import { promisify } from 'node:util'
import { inflateRawSync } from 'node:zlib'

import { formatMoment, localDay } from './model.js'

const execFileAsync = promisify(execFile)

/** macOS sqlite3 CLI (also present on Linux hosts). */
const SQLITE = '/usr/bin/sqlite3'

/** Audio/video extensions the browser pipeline can decode and the host can transcode. */
export const AUDIO_EXTENSIONS = ['.m4a', '.mp4', '.wav', '.mp3', '.aac', '.webm', '.mov', '.aiff', '.flac']

/** Text-ish extensions imported without transcription. */
export const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown']

/** How many files one scan may import (ASR is CPU-heavy). */
const MAX_FILES_PER_SCAN = 2
/** Ignore files larger than this; transcode/ASR would not be practical. */
const MAX_FILE_BYTES = 1.5 * 1024 * 1024 * 1024
/** Only auto-import sources newer than this. */
const RECENT_DAYS = 14
/** A file must be untouched for this long before it is considered finished. */
const STABLE_MS = 45_000
/** Poll cadence for the background scan. */
const SCAN_INTERVAL_MS = 30_000
/** A failed source is retried at most this many times. */
const MAX_ATTEMPTS = 3

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path) {
  const text = String(path ?? '').trim()
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return join(homedir(), text.slice(2))
  return text
}

/** Is this path something the auto-importer understands? */
export function fileKind(path) {
  const ext = extname(String(path ?? '')).toLowerCase()
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio'
  if (TEXT_EXTENSIONS.includes(ext) || ext === '.docx' || ext === '.json') return 'text'
  return null
}

/** Clean a filename into a plausible meeting title. */
export function titleFromFile(path) {
  const base = basename(String(path ?? '')).replace(/\.[^.]+$/, '').trim()
  return base === '' ? `录音纪要 ${formatMoment()}` : base.slice(0, 80)
}

/** Normalize one `local_record_data` row read from Tencent Meeting. */
export function normalizeTencentRow(row) {
  if (row === null || typeof row !== 'object') return null
  const path = expandHome(String(row.local_file_path ?? ''))
  if (path === '') return null
  const rawEnd = Number(row.record_end_time) || 0
  const rawStart = Number(row.start_record_time) || 0
  // Tencent writes epoch seconds; tolerate a millisecond variant as well.
  const toMs = (value) => (value > 1e12 ? value : value * 1000)
  const endMs = rawEnd > 0 ? toMs(rawEnd) : 0
  const startMs = rawStart > 0 ? toMs(rawStart) : 0
  const completed = Number(row.is_record_complete) === 1 || row.is_record_complete === true
  return {
    key: `tencent:${String(row.record_id ?? '') || path}`,
    path,
    title: String(row.record_title ?? '').trim(),
    meetingCode: String(row.meeting_code ?? '').trim(),
    endAt: endMs,
    startAt: startMs,
    completed,
    size: Number(row.total_size) || 0,
  }
}

/** Extract readable text from a Tencent/office JSON or plain export. */
export function extractTextPayload(raw) {
  const text = String(raw ?? '')
  const trimmed = text.trim()
  if (trimmed === '') return ''
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      const found = deepText(parsed)
      if (found !== '') return found
    } catch {
      // Not JSON; fall through to the raw text.
    }
  }
  return text
}

/** Find the first large text field in a JSON export. */
function deepText(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim().length > 20 ? value : ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepText(item, depth + 1)
      if (found !== '') return found
    }
    return ''
  }
  if (typeof value === 'object') {
    for (const key of ['transcript', 'transcription', 'minutes', 'content', 'summary', 'text', 'sentences', 'paragraphs']) {
      if (key in value) {
        const found = deepText(value[key], depth + 1)
        if (found !== '') return found
      }
    }
    for (const child of Object.values(value)) {
      const found = deepText(child, depth + 1)
      if (found !== '') return found
    }
  }
  return ''
}

/** Extract `<w:t>` text from a docx's document.xml. */
export function docxXmlToText(xml) {
  return String(xml ?? '')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 从一个 ZIP 包（docx 就是 ZIP）里取出指定条目；支持 store/deflate 两种方式。
 * 用 Node 自带 zlib 实现，跨平台（Windows 上没有 /usr/bin/unzip）。
 * @param buffer - 整个文件字节。
 * @param entryName - 包内路径，如 `word/document.xml`。
 * @returns Buffer 或 null。
 */
export function readZipEntry(buffer, entryName) {
  let eocd = -1
  const floor = Math.max(0, buffer.length - 66_000)
  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 docx（缺少 ZIP 目录）')
  const entries = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    if (name === entryName) {
      if (localOffset + 30 > buffer.length) break
      const localNameLength = buffer.readUInt16LE(localOffset + 26)
      const localExtraLength = buffer.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + localNameLength + localExtraLength
      const data = buffer.subarray(dataStart, dataStart + compressedSize)
      if (method === 0) return data
      if (method === 8) return inflateRawSync(data)
      throw new Error(`docx 使用了不支持的压缩方式（${method}）`)
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  return null
}

/** 读取 .docx 的正文纯文本（跨平台，无外部命令）。 */
export async function readDocxText(filePath) {
  const buffer = await readFile(filePath)
  const xml = readZipEntry(buffer, 'word/document.xml')
  if (xml === null) throw new Error('docx 里没有 word/document.xml')
  return docxXmlToText(xml.toString('utf8'))
}

/** The Tencent Meeting database directory inside the macOS app container. */
export function tencentDatabaseDirs() {
  const base = join(homedir(), 'Library/Containers/com.tencent.meeting/Data/Library')
  return [join(base, 'Global/Database'), join(base, 'Users')]
}

/**
 * 腾讯会议本地录制的常见根目录（Windows 默认在「文档\\TencentMeeting」）。
 * 只用于自动探测；用户可以在设置里手动选择任意目录覆盖它。
 */
export function defaultTencentDirs() {
  const home = homedir()
  const bases = [join(home, 'Documents')]
  const oneDrive = process.env.OneDrive
  if (typeof oneDrive === 'string' && oneDrive !== '') bases.push(join(oneDrive, 'Documents'))
  const candidates = []
  for (const base of bases) {
    candidates.push(join(base, 'TencentMeeting'), join(base, 'WeMeet'))
  }
  candidates.push(join(home, 'Videos', 'TencentMeeting'))
  const seen = new Set()
  return candidates.filter((dir) => {
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 目录是否存在且真的是目录。 */
function directoryExists(dir) {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * 选择本次使用的腾讯会议录制目录：手动配置优先，否则在默认位置里探测。
 * @returns `{ dir, source: 'config'|'detected'|'none' }`。
 */
export function resolveTencentDir(config) {
  const configured = expandHome(String(config?.tencentDir ?? '').trim())
  if (configured !== '') return { dir: configured, source: 'config' }
  for (const candidate of defaultTencentDirs()) {
    if (directoryExists(candidate)) return { dir: candidate, source: 'detected' }
  }
  return { dir: '', source: 'none' }
}

/** 判断一个文件是否位于某个目录下（Windows 不区分大小写）。 */
function isUnder(file, dir) {
  const target = process.platform === 'win32' ? dir.toLowerCase() : dir
  const value = process.platform === 'win32' ? file.toLowerCase() : file
  return value === target || value.startsWith(target.endsWith(sep) ? target : target + sep)
}

/**
 * Create the auto-ingest engine.
 * @param options - `store`, `asr`, `logger`.
 */
export function createAutoIngest(options) {
  const store = options.store
  const asr = options.asr
  const logger = options.logger

  const runtime = {
    scanning: false,
    pending: 0,
    tencent: {
      available: false,
      mode: 'none',
      dirPath: '',
      dirSource: 'none',
      dbPath: null,
      records: 0,
      error: null,
    },
    lastResult: null,
    timer: 0,
    stopped: false,
    dbPath: null,
    lastDbProbeAt: 0,
  }

  /** Read a SQLite database as JSON through the system CLI (read-only). */
  async function sqliteJson(dbPath, sql) {
    const { stdout } = await execFileAsync(SQLITE, ['-json', `file:${dbPath}?mode=ro`, sql], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    const text = String(stdout ?? '').trim()
    if (text === '') return []
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : []
  }

  /** Find the database that owns `local_record_data` (cached). */
  async function findTencentDb(force = false) {
    if (!force && runtime.dbPath !== null) return runtime.dbPath
    if (!force && Date.now() - runtime.lastDbProbeAt < 60_000) return runtime.dbPath
    runtime.lastDbProbeAt = Date.now()
    const candidates = []
    for (const dir of tencentDatabaseDirs()) {
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.db')) candidates.push(join(dir, entry.name))
          else if (entry.isDirectory() && dir.endsWith('Users')) {
            try {
              const inner = join(dir, entry.name, 'Database')
              for (const child of await readdir(inner, { withFileTypes: true })) {
                if (child.isFile() && child.name.endsWith('.db')) candidates.push(join(inner, child.name))
              }
            } catch {
              // A user directory without a Database folder is normal.
            }
          }
        }
      } catch {
        // The app may not be installed for this user.
      }
    }
    for (const db of candidates) {
      try {
        const rows = await sqliteJson(db, "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='local_record_data'")
        const present = Number(rows?.[0]?.n) > 0
        if (present) {
          runtime.dbPath = db
          return db
        }
      } catch {
        // Unreadable/encrypted databases are skipped; another one may match.
      }
    }
    runtime.dbPath = null
    return null
  }

  /** 递归收集目录下的可导入文件（腾讯会议按「账号/会议」分子目录，最多 3 层）。 */
  async function collectTencentFiles(root) {
    const files = []
    const walk = async (current, depth) => {
      let entries
      try {
        entries = await readdir(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (files.length >= 200) return
        if (entry.name.startsWith('.')) continue
        const full = join(current, entry.name)
        if (entry.isDirectory()) {
          if (depth < 3) await walk(full, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        if (fileKind(full) === null) continue
        const lower = entry.name.toLowerCase()
        if (lower.endsWith('.tmp') || lower.endsWith('.part') || lower.endsWith('.crdownload')) continue
        let info
        try {
          info = await stat(full)
        } catch {
          continue
        }
        files.push({ path: full, mtimeMs: info.mtimeMs })
      }
    }
    await walk(root, 0)
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return files
  }

  /** 目录模式的录制清单（Windows 默认走这里）：每个可导入文件算一条。 */
  async function listTencentDirectoryFiles(resolved) {
    if (resolved.dir === '') {
      runtime.tencent = {
        available: false,
        mode: 'none',
        dirPath: '',
        dirSource: 'none',
        dbPath: null,
        records: 0,
        error: '未找到腾讯会议录制目录（可在设置里手动选择）',
      }
      return []
    }
    if (!directoryExists(resolved.dir)) {
      runtime.tencent = {
        available: false,
        mode: 'directory',
        dirPath: resolved.dir,
        dirSource: resolved.source,
        dbPath: null,
        records: 0,
        error: '腾讯会议录制目录不存在：' + resolved.dir,
      }
      return []
    }
    const files = await collectTencentFiles(resolved.dir)
    runtime.tencent = {
      available: true,
      mode: 'directory',
      dirPath: resolved.dir,
      dirSource: resolved.source,
      dbPath: null,
      records: files.length,
      error: null,
    }
    return files.map((file) => ({
      key: 'tencent:' + file.path,
      path: file.path,
      title: titleFromFile(file.path),
      meetingCode: '',
      endAt: file.mtimeMs,
      completed: true,
    }))
  }

  /** 数据库模式的录制清单（macOS 容器里的 local_record_data）。 */
  async function listTencentDatabaseRecords() {
    const db = await findTencentDb()
    if (db === null) {
      runtime.tencent = {
        available: false,
        mode: 'database',
        dirPath: '',
        dirSource: 'none',
        dbPath: null,
        records: 0,
        error: '未找到腾讯会议本地录制数据库',
      }
      return []
    }
    try {
      const rows = await sqliteJson(db, [
        'SELECT record_id, record_title, local_file_path, meeting_code,',
        'record_end_time, start_record_time, total_size, is_record_complete',
        'FROM local_record_data',
        'WHERE is_record_complete = 1 AND local_file_path IS NOT NULL AND local_file_path <> ""',
        'ORDER BY record_end_time DESC LIMIT 40',
      ].join(' '))
      const records = rows.map(normalizeTencentRow).filter((row) => row !== null && row.completed)
      runtime.tencent = {
        available: true,
        mode: 'database',
        dirPath: '',
        dirSource: 'none',
        dbPath: db,
        records: records.length,
        error: null,
      }
      return records
    } catch (error) {
      runtime.tencent = {
        available: true,
        mode: 'database',
        dirPath: '',
        dirSource: 'none',
        dbPath: db,
        records: 0,
        error: `读取腾讯会议录制列表失败：${error instanceof Error ? error.message : String(error)}`,
      }
      return []
    }
  }

  /**
   * 读取腾讯会议录制清单：手动/探测到的目录优先（Windows 唯一方式），
   * macOS 未配置目录时回退 old-school 的本地数据库。
   */
  async function listTencentRecords(config) {
    const resolved = resolveTencentDir(config)
    if (resolved.source === 'config' || process.platform !== 'darwin') {
      return listTencentDirectoryFiles(resolved)
    }
    return listTencentDatabaseRecords()
  }

  /** Has this source already been imported (or failed too often)? */
  function alreadyHandled(config, key) {
    if (config.ingested[key] !== undefined) return true
    const failure = config.failures[key]
    return failure !== undefined && Number(failure.count) >= MAX_ATTEMPTS
  }

  /** Create one meeting from transcribed/imported text. */
  async function storeIngested({ key, title, date, transcript, seconds, notes, sourceType }) {
    const meeting = await store.add({
      title,
      date,
      attendees: [],
      transcript,
      transcriptSeconds: seconds,
      notes,
      sourceType,
      autoImported: true,
    })
    await store.markAutoIngested(key, { meetingId: meeting.id, title: meeting.title, path: notes })
    logger?.info?.(`meeting-minutes: auto-ingested ${key} as ${meeting.id}`)
    return meeting
  }

  /** Import one audio/video/text source; failures are recorded per source. */
  async function ingestSource({ key, path, title, date, notePrefix }) {
    try {
      const info = await stat(path)
      if (!info.isFile()) return null
      if (info.size > MAX_FILE_BYTES) throw new Error(`文件过大（${Math.round(info.size / 1024 / 1024)}MB），未自动转写`)
      const kind = fileKind(path)
      if (kind === null) return null
      const isFresh = Date.now() - info.mtimeMs < STABLE_MS
      if (isFresh) return null

      if (kind === 'audio') {
        const result = await asr.transcribeFile(path, { language: 'zh' })
        if (result.text.trim() === '') throw new Error('音频没有识别出文字')
        const notes = `${notePrefix}\n文件：${path}`
        return await storeIngested({
          key,
          title: title || titleFromFile(path),
          date: date || localDay(new Date(info.mtimeMs)),
          transcript: result.text,
          seconds: result.audioSeconds,
          notes,
          sourceType: 'recording',
        })
      }

      let text = ''
      const ext = extname(path).toLowerCase()
      if (ext === '.docx') {
        text = await readDocxText(path)
      } else {
        text = extractTextPayload(await readFile(path, 'utf8'))
      }
      if (text.trim() === '') throw new Error('文件没有可导入的文字')
      return await storeIngested({
        key,
        title: title || titleFromFile(path),
        date: date || localDay(new Date(info.mtimeMs)),
        transcript: text,
        seconds: 0,
        notes: `${notePrefix}\n文件：${path}`,
        sourceType: 'import',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`meeting-minutes: auto-ingest failed for ${path}: ${message}`)
      await store.markAutoFailure(key, message)
      runtime.lastResult = { ok: false, error: message, path }
      return null
    }
  }

  /** Import finished Tencent local recordings. */
  async function scanTencent(config, budget) {
    if (config.tencent === false) return budget
    const records = await listTencentRecords(config)
    const cutoff = Date.now() - RECENT_DAYS * 86_400_000
    for (const record of records) {
      if (budget <= 0) break
      if (record.endAt > 0 && record.endAt < cutoff) continue
      if (alreadyHandled(config, record.key)) continue
      const date = record.endAt > 0 ? localDay(new Date(record.endAt)) : localDay()
      const notePrefix = [
        '自动导入：腾讯会议本地录制',
        record.meetingCode === '' ? '' : `会议号：${record.meetingCode}`,
        record.endAt > 0 ? `录制结束：${formatMoment(new Date(record.endAt))}` : '',
      ].filter((line) => line !== '').join('\n')
      const meeting = await ingestSource({
        key: record.key,
        path: record.path,
        title: record.title,
        date,
        notePrefix,
      })
      if (meeting !== null) budget -= 1
      // The in-memory config is stale after each store write; refresh it.
      config = store.autoIngest
    }
    return budget
  }

  /** Import new files from the configured folders (two levels deep). */
  async function scanDirs(config, budget, tencentRoot = '') {
    if (config.dirsEnabled === false) return budget
    const cutoff = Date.now() - RECENT_DAYS * 86_400_000
    for (const rawDir of config.dirs) {
      if (budget <= 0) break
      const dir = expandHome(rawDir)
      const files = []
      const walk = async (current, depth) => {
        let entries
        try {
          entries = await readdir(current, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue
          const full = join(current, entry.name)
          if (entry.isDirectory()) {
            if (depth < 1) await walk(full, depth + 1)
            continue
          }
          if (!entry.isFile()) continue
          if (fileKind(full) === null) continue
          files.push(full)
        }
      }
      await walk(dir, 0)
      for (const path of files) {
        if (budget <= 0) break
        let info
        try {
          info = await stat(path)
        } catch {
          continue
        }
        if (info.mtimeMs < cutoff) continue
        // 腾讯会议目录已经单独扫描过，避免同一条录制被两个来源各导入一次。
        if (tencentRoot !== '' && isUnder(path, tencentRoot)) continue
        const key = `dir:${path}`
        if (alreadyHandled(config, key)) continue
        const meeting = await ingestSource({
          key,
          path,
          title: '',
          date: '',
          notePrefix: '自动导入：监控目录',
        })
        if (meeting !== null) budget -= 1
        config = store.autoIngest
      }
    }
    return budget
  }

  /** Run one scan now; concurrent calls share a single pass. */
  async function scanNow() {
    if (runtime.scanning || runtime.stopped) return status()
    const config = store.autoIngest
    if (config.enabled === false) return status()
    runtime.scanning = true
    runtime.pending = 0
    try {
      let budget = await scanTencent(config, MAX_FILES_PER_SCAN)
      const latestConfig = store.autoIngest
      budget = await scanDirs(latestConfig, budget, resolveTencentDir(latestConfig).dir)
      await store.noteAutoScan({ lastScanAt: new Date().toISOString(), lastError: null })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await store.noteAutoScan({ lastScanAt: new Date().toISOString(), lastError: message })
      runtime.lastResult = { ok: false, error: message }
      logger?.warn?.(`meeting-minutes: auto-ingest scan failed: ${message}`)
    } finally {
      runtime.scanning = false
      runtime.pending = 0
    }
    return status()
  }

  /** Public status projection for the panel and `GET /state`. */
  function status() {
    const config = store.autoIngest
    // 还没扫描过时，目录信息从配置/探测结果即时算出来，面板选完目录就能看到。
    const resolved = resolveTencentDir(config)
    const recent = Object.entries(config.ingested)
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 5)
    return {
      enabled: config.enabled,
      tencent: config.tencent,
      tencentDir: config.tencentDir,
      tencentDirPath: runtime.tencent.dirPath !== '' ? runtime.tencent.dirPath : resolved.dir,
      tencentDirSource: runtime.tencent.dirSource !== 'none' ? runtime.tencent.dirSource : resolved.source,
      tencentMode: runtime.tencent.mode !== 'none'
        ? runtime.tencent.mode
        : (resolved.dir !== '' ? 'directory' : (process.platform === 'darwin' ? 'database' : 'none')),
      dirs: [...config.dirs],
      dirsEnabled: config.dirsEnabled === true,
      tencentAvailable: runtime.tencent.available,
      tencentDbPath: runtime.tencent.dbPath,
      tencentRecords: runtime.tencent.records,
      tencentError: runtime.tencent.error,
      scanning: runtime.scanning,
      pending: runtime.pending,
      lastScanAt: config.lastScanAt,
      lastError: config.lastError,
      importedCount: config.importedCount,
      failedCount: Object.keys(config.failures).length,
      recent,
    }
  }

  /** Merge a configuration patch and persist it. */
  async function setConfig(patch) {
    const next = {}
    if (patch?.enabled !== undefined) next.enabled = patch.enabled !== false
    if (patch?.tencent !== undefined) next.tencent = patch.tencent !== false
    if (patch?.tencentDir !== undefined) next.tencentDir = String(patch.tencentDir ?? '').trim()
    if (Array.isArray(patch?.dirs)) next.dirs = patch.dirs.map((dir) => String(dir).trim()).filter((dir) => dir !== '')
    if (patch?.dirsEnabled !== undefined) next.dirsEnabled = patch.dirsEnabled !== false
    await store.setAutoIngest(next)
    return status()
  }

  /** Start the background poll; returns a disposer. */
  function start() {
    runtime.stopped = false
    const tick = () => {
      void scanNow().catch(() => {})
    }
    runtime.timer = setInterval(tick, SCAN_INTERVAL_MS)
    if (typeof runtime.timer.unref === 'function') runtime.timer.unref()
    const kick = setTimeout(tick, 4_000)
    if (typeof kick.unref === 'function') kick.unref()
    return () => {
      runtime.stopped = true
      if (runtime.timer) clearInterval(runtime.timer)
      runtime.timer = 0
      clearTimeout(kick)
    }
  }

  return { status, setConfig, scanNow, start }
}
