/**
 * 从本地文件夹读取文本，供「术语提取」使用。
 *
 * 支持：.txt / .md / .markdown / .json / .csv / .log / .html / .htm / .xml 以及 .docx。
 * 不支持的格式（图片、音频、PDF、xlsx 等）会被跳过并在统计里计数，不会报错。
 * 读取的是用户自己的本地文件，只在本机拼成一段文本发给当前配置的总结模型。
 *
 * @module dsh-meeting-live/term-extract
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { inflateRawSync } from 'node:zlib'

/** 可解析为纯文本的扩展名。 */
export const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.html', '.htm', '.xml']
/** 支持 Word 文档（.docx）；老的 .doc 不支持。 */
export const WORD_EXTENSIONS = ['.docx']

const MAX_FILES = 200
const MAX_DEPTH = 3
/** 单个文件最多取多少字符。 */
const MAX_FILE_CHARS = 12000
/** 汇总后最多发给模型多少字符（控制 token 成本与耗时）。 */
export const MAX_SEND_CHARS = 60000
/** 单个文件读取上限（防止误读超大文件）。 */
const MAX_READ_BYTES = 8 * 1024 * 1024

/** 解码文本文件：优先 UTF-8，失败时回退 GB18030（Windows 常见编码）。 */
function decodeText(buffer) {
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
    const bad = (utf8.match(/\uFFFD/g) ?? []).length
    if (bad <= Math.max(2, utf8.length * 0.002)) return utf8
  } catch { }
  try {
    return new TextDecoder('gb18030', { fatal: false }).decode(buffer)
  } catch {
    return buffer.toString('utf8')
  }
}

/** 解 XML 常见实体，并去掉标签、保留段落换行。 */
function xmlToText(xml) {
  return String(xml)
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-fA-F]+);/g, (all, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (all, dec) => String.fromCodePoint(Number(dec)))
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 读取 .docx 的正文文本：只依赖 Node 的 zlib 手写一个最小 ZIP 读取器。
 * @param buffer - 整个 .docx 文件的 Buffer。
 */
export function docxToText(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (end < 0) throw new Error('不是有效的 .docx（缺少 ZIP 结尾）')
  const entries = []
  const centralOffset = buffer.readUInt32LE(end + 16)
  let cursor = centralOffset
  while (cursor + 46 <= buffer.length && buffer.readUInt32LE(cursor) === 0x02014b50) {
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    entries.push({ name, method, compressedSize, localOffset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  const parts = []
  for (const entry of entries) {
    if (!/^word\/(document|header\d*|footer\d*)\.xml$/.test(entry.name)) continue
    try {
      const local = entry.localOffset
      if (buffer.readUInt32LE(local) !== 0x04034b50) continue
      const nameLength = buffer.readUInt16LE(local + 26)
      const extraLength = buffer.readUInt16LE(local + 28)
      const dataStart = local + 30 + nameLength + extraLength
      const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize)
      const xml = entry.method === 8 ? inflateRawSync(compressed) : compressed
      const text = xmlToText(xml.toString('utf8'))
      if (text !== '') parts.push(text)
    } catch { }
  }
  return parts.join('\n\n').trim()
}

/** 读一个文件为纯文本；不支持的扩展名返回空字符串。 */
async function readOneFile(filePath) {
  const ext = extname(filePath).toLowerCase()
  if (WORD_EXTENSIONS.includes(ext)) {
    const buffer = await readFile(filePath)
    if (buffer.length > MAX_READ_BYTES) return ''
    return docxToText(buffer)
  }
  if (TEXT_EXTENSIONS.includes(ext)) {
    const info = await stat(filePath)
    if (info.size > MAX_READ_BYTES) return ''
    const buffer = await readFile(filePath)
    let text = decodeText(buffer)
    if (ext === '.html' || ext === '.htm' || ext === '.xml') text = xmlToText(text)
    return text.trim()
  }
  return ''
}

/**
 * 递归扫描文件夹，读取支持的文件并拼成一段文本。
 * @param dir - 绝对路径。
 * @returns `{ text, stats: { files, supported, skipped, chars, truncated }, names }`。
 */
export async function scanFolder(dir) {
  const folder = typeof dir === 'string' ? dir.trim() : ''
  if (folder === '') throw new Error('请先选择要解析的文件夹')
  let info = null
  try {
    info = await stat(folder)
  } catch {
    throw new Error('文件夹不存在或无法读取：' + folder)
  }
  if (!info.isDirectory()) throw new Error('选择的路径不是文件夹：' + folder)

  const filePaths = []
  let skipped = 0
  let visitedDirs = 0
  const walk = async (current, depth) => {
    if (depth > MAX_DEPTH || filePaths.length >= MAX_FILES) return
    visitedDirs += 1
    let entries = []
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (filePaths.length >= MAX_FILES) return
      if (entry.name.startsWith('.')) { skipped += 1; continue }
      if (entry.name === 'node_modules' || entry.name === '__pycache__') { skipped += 1; continue }
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase()
        if (TEXT_EXTENSIONS.includes(ext) || WORD_EXTENSIONS.includes(ext)) filePaths.push(full)
        else skipped += 1
      }
    }
  }
  await walk(folder, 0)

  const chunks = []
  const names = []
  let total = 0
  let truncated = false
  let supported = 0
  for (const filePath of filePaths) {
    let text = ''
    try {
      text = await readOneFile(filePath)
    } catch {
      skipped += 1
      continue
    }
    if (text === '') { skipped += 1; continue }
    supported += 1
    const relativeName = relative(folder, filePath).replace(/\\/g, '/')
    names.push(relativeName)
    const clipped = text.length > MAX_FILE_CHARS ? text.slice(0, MAX_FILE_CHARS) : text
    if (text.length > MAX_FILE_CHARS) truncated = true
    const block = '\n\n===== 文件：' + relativeName + ' =====\n' + clipped
    if (total + block.length > MAX_SEND_CHARS) {
      truncated = true
      break
    }
    chunks.push(block)
    total += block.length
  }

  return {
    text: chunks.join('').trim(),
    names,
    stats: {
      files: filePaths.length + skipped,
      supported,
      skipped,
      chars: total,
      truncated,
      dirs: visitedDirs,
    },
  }
}
