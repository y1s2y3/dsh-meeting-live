/**
 * 从本地文件夹读取文本，供「术语提取」使用。
 *
 * 支持：.txt / .md / .markdown / .json / .csv / .log / .html / .htm / .xml
 *      + .docx（Word 正文）
 *      + .xlsx（Excel 共享字符串 / 单元格文本）
 *      + .pdf（文本层；扫描件/图片 PDF 没有文本层，读不出来）
 * 不支持的格式（图片、音频、旧版 .doc/.xls 等）会被跳过并在统计里计数。
 *
 * 全部实现只依赖 Node 标准库（zlib 解压 + 手写 ZIP/PDF 解析），不新增依赖。
 *
 * @module dsh-meeting-live/term-extract
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import { inflateRawSync, inflateSync } from 'node:zlib'

/** 纯文本扩展名。 */
export const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.html', '.htm', '.xml']
/** Word 文档（仅 .docx，老的 .doc 不支持）。 */
export const WORD_EXTENSIONS = ['.docx']
/** Excel 表格（仅 .xlsx，老的 .xls 不支持）。 */
export const EXCEL_EXTENSIONS = ['.xlsx']
/** PDF：只提取文本层（Word/WPS 导出的 PDF 一般有 ToUnicode 映射）。 */
export const PDF_EXTENSIONS = ['.pdf']

const MAX_FILES = 200
const MAX_DEPTH = 3
/** 单个文件最多取多少字符。 */
const MAX_FILE_CHARS = 12000
/** 单次解析最多发给模型多少字符（控制 token 成本与耗时）。 */
export const MAX_SEND_CHARS = 60000
/** 单个文件夹数量上限。 */
export const MAX_FOLDERS = 12
/** 单个文件读取上限（防止误读超大文件）。 */
const MAX_READ_BYTES = 20 * 1024 * 1024

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
 * 读取 ZIP 内所有条目（docx / xlsx 共用）。
 * @returns `[{ name, method, compressed, data }]`，data 为解压后的 Buffer。
 */
export function readZipEntries(buffer) {
  const entries = []
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (end < 0) throw new Error('不是有效的 ZIP 文件（缺少 ZIP 结尾）')
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
    if (buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26)
      const localExtraLength = buffer.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + localNameLength + localExtraLength
      const compressed = buffer.subarray(dataStart, dataStart + compressedSize)
      let data = compressed
      try {
        if (method === 8) data = inflateRawSync(compressed)
      } catch {
        data = Buffer.alloc(0)
      }
      entries.push({ name, method, compressed, data })
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** 读取 .docx 的正文文本。 */
export function docxToText(buffer) {
  const entries = readZipEntries(buffer)
  const parts = []
  for (const entry of entries) {
    if (!/^word\/(document|header\d*|footer\d*)\.xml$/.test(entry.name)) continue
    const text = xmlToText(entry.data.toString('utf8'))
    if (text !== '') parts.push(text)
  }
  return parts.join('\n\n').trim()
}

/** 从 XML 片段里取所有 `<t>` 的文本（兼容 sharedStrings 的富文本 run）。 */
function textOfSharedString(xml) {
  const parts = []
  const regex = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g
  let match = regex.exec(xml)
  while (match !== null) {
    parts.push(match[1])
    match = regex.exec(xml)
  }
  return xmlToText(parts.join(''))
}

/** 读取 .xlsx：共享字符串 + 单元格文本（按工作表分行/分列）。 */
export function xlsxToText(buffer) {
  const entries = readZipEntries(buffer)
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  const sharedEntry = byName.get('xl/sharedStrings.xml')
  const shared = []
  if (sharedEntry !== undefined) {
    const xml = sharedEntry.data.toString('utf8')
    const regex = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g
    let match = regex.exec(xml)
    while (match !== null) {
      shared.push(textOfSharedString(match[1]))
      match = regex.exec(xml)
    }
  }
  const sheetNames = [...byName.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d*\.xml$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const sheets = []
  for (const sheetName of sheetNames) {
    const xml = byName.get(sheetName).data.toString('utf8')
    const rows = []
    const rowRegex = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g
    let rowMatch = rowRegex.exec(xml)
    while (rowMatch !== null) {
      const cells = []
      const cellRegex = /<c(?:\s([^>]*))?>([\s\S]*?)<\/c>/g
      let cellMatch = cellRegex.exec(rowMatch[1])
      while (cellMatch !== null) {
        const attrs = cellMatch[1] ?? ''
        const body = cellMatch[2] ?? ''
        const type = (/\bt="([^"]+)"/.exec(attrs) ?? [])[1] ?? ''
        const valueMatch = /<v>([\s\S]*?)<\/v>/.exec(body)
        const inlineMatch = /<is>([\s\S]*?)<\/is>/.exec(body)
        let text = ''
        if (type === 's' && valueMatch !== null) {
          text = shared[Number(valueMatch[1])] ?? ''
        } else if (type === 'inlineStr' && inlineMatch !== null) {
          text = textOfSharedString(inlineMatch[1])
        } else if (valueMatch !== null) {
          text = xmlToText(valueMatch[1])
        } else if (inlineMatch !== null) {
          text = textOfSharedString(inlineMatch[1])
        }
        if (text !== '') cells.push(text.replace(/\s+/g, ' ').trim())
        cellMatch = cellRegex.exec(rowMatch[1])
      }
      if (cells.length > 0) rows.push(cells.join('\t'))
      rowMatch = rowRegex.exec(xml)
    }
    if (rows.length > 0) sheets.push(rows.join('\n'))
  }
  return sheets.join('\n\n').trim()
}

/* ───────────────────────────── PDF 文本层 ───────────────────────────── */

/** 从 PDF 的 ToUnicode CMap 里解析 code → Unicode 映射。 */
function parseToUnicodeCMap(text) {
  const map = new Map()
  const toUnicode = (hex) => {
    const bytes = Buffer.from(hex, 'hex')
    if (bytes.length === 0) return ''
    if (bytes.length % 2 === 0) {
      let out = ''
      for (let index = 0; index < bytes.length; index += 2) out += String.fromCharCode(bytes.readUInt16BE(index))
      return out
    }
    return bytes.toString('latin1')
  }
  const charRegex = /beginbfchar([\s\S]*?)endbfchar/g
  let match = charRegex.exec(text)
  while (match !== null) {
    const pairRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g
    let pair = pairRegex.exec(match[1])
    while (pair !== null) {
      map.set(parseInt(pair[1], 16), toUnicode(pair[2]))
      pair = pairRegex.exec(match[1])
    }
    match = charRegex.exec(text)
  }
  const rangeRegex = /beginbfrange([\s\S]*?)endbfrange/g
  let range = rangeRegex.exec(text)
  while (range !== null) {
    const lineRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[\s\S]*?\]|<[0-9a-fA-F]*>)/g
    let line = lineRegex.exec(range[1])
    while (line !== null) {
      const start = parseInt(line[1], 16)
      const end = parseInt(line[2], 16)
      const target = line[3]
      if (target.startsWith('[')) {
        const items = [...target.matchAll(/<([0-9a-fA-F]+)>/g)].map((item) => item[1])
        for (let code = start; code <= end && code - start < items.length; code += 1) {
          map.set(code, toUnicode(items[code - start]))
        }
      } else {
        const base = target.slice(1, -1)
        const baseBytes = Buffer.from(base, 'hex')
        if (baseBytes.length >= 2) {
          const baseCode = baseBytes.readUInt16BE(0)
          for (let code = start; code <= end; code += 1) {
            const offset = code - start
            map.set(code, String.fromCharCode(baseCode + offset))
          }
        }
      }
      line = lineRegex.exec(range[1])
    }
    range = rangeRegex.exec(text)
  }
  return map
}

/** 把二进制 Buffer 转成「每字节一字符」的 latin1 字符串，便于按偏移找语法。 */
function latin1(buffer) {
  return buffer.toString('latin1')
}

/** 解压 PDF stream（支持 FlateDecode；其它过滤器原样返回）。 */
function decodePdfStream(dict, data) {
  const filter = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict)?.[1] ?? ''
  if (!/FlateDecode/.test(filter)) return data
  try {
    return inflateSync(data)
  } catch {
    return Buffer.alloc(0)
  }
}

/** 从内容流里提取文字；fontMap 为字体名 → (code → unicode) 映射。 */
function extractTextFromContent(content, fontMaps) {
  const text = latin1(content)
  let out = ''
  let currentMap = null
  let lastY = null
  const pushText = (value) => {
    if (value === '') return
    out += value
  }
  const decodeString = (bytes) => {
    if (currentMap !== null && currentMap.size > 0) {
      let result = ''
      const twoByte = [...currentMap.keys()].some((key) => key > 0xff)
      if (twoByte) {
        for (let index = 0; index + 1 < bytes.length; index += 2) {
          const code = bytes[index] * 256 + bytes[index + 1]
          result += currentMap.get(code) ?? ''
        }
      } else {
        for (const byte of bytes) result += currentMap.get(byte) ?? ''
      }
      if (result !== '') return result
    }
    return bytes.toString('latin1')
  }
  const literalRegex = /\((?:\\.|[^\\()])*\)/g
  const hexRegex = /<([0-9a-fA-F\s]+)>/g
  // 逐段扫描：先找 Tf 切字体，再收集字符串；按 Td/Tm 的 y 变化换行。
  const tokenRegex = /\/([A-Za-z0-9]+)\s+[\d.]+\s+Tf|\[((?:[^\[\]]|\((?:\\.|[^\\()])*\))*)\]\s*TJ|\(((?:\\.|[^\\()])*)\)\s*(?:Tj|'|")|<([0-9a-fA-F\s]+)>\s*Tj|([\d.+-]+)\s+([\d.+-]+)\s+(?:Td|TD)|([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+Tm|T\*/g
  let match = tokenRegex.exec(text)
  while (match !== null) {
    if (match[1] !== undefined) {
      currentMap = fontMaps.get(match[1]) ?? null
    } else if (match[4] !== undefined) {
      pushText(decodeString(Buffer.from(match[4].replace(/\s+/g, ''), 'hex')))
    } else if (match[3] !== undefined) {
      pushText(decodeString(decodePdfLiteral(match[3])))
    } else if (match[2] !== undefined) {
      for (const literal of match[2].matchAll(/\(((?:\\.|[^\\()])*)\)/g)) pushText(decodeString(decodePdfLiteral(literal[1])))
      for (const hex of match[2].matchAll(/<([0-9a-fA-F\s]+)>/g)) pushText(decodeString(Buffer.from(hex[1].replace(/\s+/g, ''), 'hex')))
    } else if (match[5] !== undefined) {
      const y = Number(match[6])
      if (lastY !== null && Math.abs(y - lastY) > 1) out += '\n'
      else out += ' '
      lastY = y
    } else if (match[7] !== undefined) {
      const y = Number(match[12])
      if (lastY !== null && Math.abs(y - lastY) > 1) out += '\n'
      lastY = y
    } else if (match[0] === 'T*') {
      out += '\n'
    }
    match = tokenRegex.exec(text)
  }
  return out
}

/** 解析 PDF 字符串字面量里的转义。 */
function decodePdfLiteral(value) {
  const bytes = []
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char !== '\\') { bytes.push(char.charCodeAt(0)); continue }
    const next = value[index + 1]
    if (next === undefined) break
    if (next === 'n') { bytes.push(10); index += 1 } else if (next === 'r') { bytes.push(13); index += 1 } else if (next === 't') { bytes.push(9); index += 1 } else if (next === 'b') { bytes.push(8); index += 1 } else if (next === 'f') { bytes.push(12); index += 1 } else if (next === '(' || next === ')' || next === '\\') { bytes.push(next.charCodeAt(0)); index += 1 } else if (/[0-7]/.test(next)) {
      let octal = next
      index += 1
      while (octal.length < 3 && value[index + 1] !== undefined && /[0-7]/.test(value[index + 1])) { octal += value[index + 1]; index += 1 }
      bytes.push(parseInt(octal, 8))
    } else { bytes.push(next.charCodeAt(0)); index += 1 }
  }
  return Buffer.from(bytes)
}

/**
 * 提取 PDF 文本层。
 * 说明：只处理未加密 PDF；扫描件/纯图片 PDF 没有文本层，返回空字符串。
 * @param buffer - 整个 PDF 文件的 Buffer。
 */
export function pdfToText(buffer) {
  const raw = latin1(buffer)
  if (/\/Encrypt\b/.test(raw)) return ''
  // 收集对象：obj 偏移 → 内容（dict + 原始 stream）
  const objects = []
  const objectRegex = /\b(\d+)\s+(\d+)\s+obj\b/g
  let match = objectRegex.exec(raw)
  while (match !== null) {
    const start = match.index
    const end = raw.indexOf('endobj', start)
    if (end < 0) break
    const body = raw.slice(start + match[0].length, end)
    objects.push({ number: Number(match[1]), body })
    match = objectRegex.exec(raw)
    if (match !== null && match.index <= end) objectRegex.lastIndex = end
  }
  const objectByNumber = new Map(objects.map((item) => [item.number, item]))

  /** 取某个对象里的 stream 字节（支持 /Length 直接值或找 endstream）。 */
  const streamOf = (body) => {
    const streamIndex = body.indexOf('stream')
    if (streamIndex < 0) return null
    let dataStart = streamIndex + 'stream'.length
    if (body[dataStart] === '\r') dataStart += 1
    if (body[dataStart] === '\n') dataStart += 1
    const dataEnd = body.indexOf('endstream', dataStart)
    if (dataEnd < 0) return null
    return { dict: body.slice(0, streamIndex), data: Buffer.from(body.slice(dataStart, dataEnd), 'latin1') }
  }

  // 收集字体：/<Name> N 0 R 且对象里有 /ToUnicode 或 /Subtype
  const fontMaps = new Map()
  for (const object of objects) {
    const unicodeRef = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(object.body)
    if (unicodeRef === null) continue
    const cmapObject = objectByNumber.get(Number(unicodeRef[1]))
    if (cmapObject === undefined) continue
    const stream = streamOf(cmapObject.body)
    if (stream === null) continue
    const decoded = decodePdfStream(stream.dict, stream.data)
    if (decoded.length === 0) continue
    const cmapText = latin1(decoded)
    const cmap = parseToUnicodeCMap(cmapText)
    if (cmap.size === 0) continue
    // 字体资源名在内容流里是 /F1 形式，对象里 /BaseFont 不可靠；
    // 用「所有字体对象」建映射：按出现顺序命名 F1..Fn 与 /Font << /F1 N 0 R >> 对应。
    fontMaps.set(object.number, cmap)
  }
  // 建立资源名 → 字体对象：页面的 /Resources 里 /Font 可能是内联字典，也可能是指向字体字典的引用。
  const nameToObject = new Map()
  const addNameRefs = (dictText) => {
    const refRegex = /\/([A-Za-z0-9]+)\s+(\d+)\s+\d+\s+R/g
    let ref = refRegex.exec(dictText)
    while (ref !== null) {
      if (!/^(Type|Resources|Font|Contents|Parent|MediaBox|ToUnicode|BaseFont|FontDescriptor|FontFile\d?|Length\d?|Widths|FirstChar|LastChar|Encoding|Subtype|ProcSet)$/.test(ref[1])) {
        nameToObject.set(ref[1], Number(ref[2]))
      }
      ref = refRegex.exec(dictText)
    }
  }
  for (const object of objects) {
    const fontRef = /\/Font\s+(\d+)\s+\d+\s+R/.exec(object.body)
    if (fontRef !== null) {
      const fontDictObject = objectByNumber.get(Number(fontRef[1]))
      if (fontDictObject !== undefined) addNameRefs(fontDictObject.body)
    }
    const inlineFont = /\/Font\s*<<([\s\S]*?)>>/.exec(object.body)
    if (inlineFont !== null) addNameRefs(inlineFont[1])
    // 兜底：形如 <</F1 74 0 R/F2 59 0 R>> 的字体名映射对象
    if (!/\/Type/.test(object.body) && /\/F[A-Za-z0-9]+\s+\d+\s+\d+\s+R/.test(object.body)) addNameRefs(object.body)
  }
  const namedMaps = new Map()
  for (const [name, number] of nameToObject) {
    const cmap = fontMaps.get(number)
    if (cmap !== undefined) namedMaps.set(name, cmap)
  }
  // 逐个内容流提取文字
  const texts = []
  for (const object of objects) {
    const stream = streamOf(object.body)
    if (stream === null) continue
    const decoded = decodePdfStream(stream.dict, stream.data)
    if (decoded.length === 0) continue
    const content = latin1(decoded)
    if (!/BT[\s\S]*?(Tj|TJ)/.test(content)) continue
    const text = extractTextFromContent(decoded, namedMaps)
    if (text.trim() !== '') texts.push(text)
  }
  return texts
    .join('\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 读一个文件为纯文本；不支持的扩展名返回空字符串。 */
async function readOneFile(filePath) {
  const ext = extname(filePath).toLowerCase()
  const info = await stat(filePath)
  if (info.size > MAX_READ_BYTES) return ''
  const buffer = await readFile(filePath)
  if (WORD_EXTENSIONS.includes(ext)) return docxToText(buffer)
  if (EXCEL_EXTENSIONS.includes(ext)) return xlsxToText(buffer)
  if (PDF_EXTENSIONS.includes(ext)) return pdfToText(buffer)
  if (TEXT_EXTENSIONS.includes(ext)) {
    let text = decodeText(buffer)
    if (ext === '.html' || ext === '.htm' || ext === '.xml') text = xmlToText(text)
    return text.trim()
  }
  return ''
}

/**
 * 递归扫描一个文件夹，读取支持的文件并拼成一段文本。
 * @param dir - 绝对路径。
 * @returns `{ text, stats, names }`。
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
  const supportedExtensions = new Set([...TEXT_EXTENSIONS, ...WORD_EXTENSIONS, ...EXCEL_EXTENSIONS, ...PDF_EXTENSIONS])
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
        if (supportedExtensions.has(extname(entry.name).toLowerCase())) filePaths.push(full)
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
    stats: { files: filePaths.length + skipped, supported, skipped, chars: total, truncated, dirs: visitedDirs },
  }
}

/**
 * 扫描多个文件夹并合并文本（术语提取用）。
 * @param dirs - 文件夹路径数组（去重、最多 MAX_FOLDERS 个）。
 * @returns `{ text, names, stats: { folders, files, supported, skipped, chars, truncated } }`。
 */
export async function scanFolders(dirs) {
  const list = [...new Set((Array.isArray(dirs) ? dirs : []).map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item !== ''))].slice(0, MAX_FOLDERS)
  if (list.length === 0) throw new Error('请先选择要解析的文件夹')
  const blocks = []
  const names = []
  let files = 0
  let supported = 0
  let skipped = 0
  let chars = 0
  let truncated = false
  let total = 0
  for (const dir of list) {
    const scanned = await scanFolder(dir)
    files += scanned.stats.files
    supported += scanned.stats.supported
    skipped += scanned.stats.skipped
    truncated = truncated || scanned.stats.truncated === true
    const folderName = basename(dir.replace(/[\\/]+$/, '')) || dir
    for (const name of scanned.names) names.push(folderName + '/' + name)
    if (scanned.text === '') continue
    const block = '\n\n########## 文件夹：' + folderName + ' ##########\n' + scanned.text
    if (total + block.length > MAX_SEND_CHARS) {
      truncated = true
      const room = Math.max(0, MAX_SEND_CHARS - total)
      if (room > 0) blocks.push(block.slice(0, room))
      break
    }
    blocks.push(block)
    total += block.length
    chars += scanned.stats.chars
  }
  return {
    text: blocks.join('').trim(),
    names,
    stats: { folders: list.length, files, supported, skipped, chars, truncated },
  }
}
