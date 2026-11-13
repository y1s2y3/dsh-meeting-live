/**
 * Standalone document export for the meeting-minutes plugin.
 *
 * Two formats share one normalized meeting:
 * - `md`   — a portable Markdown minutes document,
 * - `html` — one self-contained, print-friendly HTML page with inline CSS
 *            (no external assets, no Harness runtime needed).
 *
 * @module dsh-plugin-meeting-minutes/export
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { formatMoment, todoProgress } from './model.js'

/** Escape text for HTML text nodes and attributes. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Turn a title into a filesystem-safe fragment. */
export function safeFileName(text, fallback = '会议纪要') {
  const cleaned = String(text ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')

    .trim()
  return (cleaned === '' ? fallback : cleaned).slice(0, 60)
}

/** File extension per format. */
const EXTENSION = { md: 'md', html: 'html', docx: 'docx' }

/** One Markdown bullet list, or nothing. */
function bullets(items, empty = '（无）') {
  if (!Array.isArray(items) || items.length === 0) return [`- ${empty}`]
  return items.map((item) => `- ${item}`)
}

/**
 * Build the Markdown minutes document.
 * @param meeting - canonical meeting.
 */
export function buildMarkdown(meeting) {
  const summary = meeting.summary
  const lines = [
    `# ${meeting.title} · 会议纪要`,
    '',
    `- 日期：${meeting.date}`,
    `- 参会人：${meeting.attendees.length > 0 ? meeting.attendees.join('、') : '（未填写）'}`,
    `- 来源：${meeting.sourceType === 'recording' ? '录音转写' : meeting.sourceType === 'import' ? '导入记录' : '文本导入'}`,
    meeting.transcriptSeconds > 0 ? `- 录音时长：${formatDuration(meeting.transcriptSeconds)}` : '',
    `- 导出时间：${formatMoment(new Date())}`,
    '',
  ].filter((line) => line !== '')
  if (summary === null) {
    lines.push('## 原始文本', '', meeting.transcript.trim() === '' ? '（空）' : meeting.transcript, '')
    return lines.join('\n')
  }
  lines.push(
    '## 一句话结论',
    '',
    summary.oneLine || '（未生成）',
    '',
    '## 整体概述',
    '',
    summary.overview || '（未生成）',
    '',
    '## 关键要点',
    '',
    ...summary.keyPoints.map((item, index) => `${index + 1}. ${item}`),
    '',
  )
  if (summary.decisions.length > 0) {
    lines.push('## 会议决策', '')
    for (const decision of summary.decisions) {
      lines.push(`- ${decision.text}${decision.owner === '' ? '' : `（负责人：${decision.owner}）`}`)
    }
    lines.push('')
  }
  if (summary.risks.length > 0) {
    lines.push('## 风险 / 待确认', '')
    for (const risk of summary.risks) {
      const level = risk.level === 'high' ? '高' : risk.level === 'low' ? '低' : '中'
      lines.push(`- [${level}] ${risk.text}`)
    }
    lines.push('')
  }
  if (summary.sections.length > 0) {
    lines.push('## 分节纪要', '')
    for (const section of summary.sections) {
      lines.push(`### ${section.heading}`, '')
      lines.push(...bullets(section.bullets))
      lines.push('')
    }
  }
  if (summary.todos.length > 0) {
    lines.push('## 待办事项', '', '| 状态 | 交付物 | 负责人 | 截止 | 优先级 | 备注 |', '| :-- | :-- | :-- | :-- | :-- | :-- |')
    for (const todo of summary.todos) {
      lines.push(`| ${todo.calendarTaskId === null ? '待写入日历' : '已写入日历'} | ${todo.title} | ${todo.owner || '—'} | ${todo.due || '—'} | ${priorityLabel(todo.priority)} | ${todo.notes || '—'} |`)
    }
    lines.push('')
  }
  lines.push('## 原始转写', '', '```text', meeting.transcript.trim() === '' ? '（空）' : meeting.transcript, '```', '')
  return lines.join('\n')
}

/** Chinese duration label. */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${rest} 秒`
  return `${rest} 秒`
}

/** Priority label used in documents. */
function priorityLabel(priority) {
  return priority === 'high' ? '高' : priority === 'low' ? '低' : '中'
}

/** Shared inline stylesheet for the standalone HTML document. */
const DOC_CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#eef1f6;color:#1b2330;font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,-apple-system,sans-serif;line-height:1.7;font-size:14px}
.doc{max-width:900px;margin:32px auto 56px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 18px 50px rgba(20,30,55,.14)}
.cover{padding:38px 44px 30px;background:linear-gradient(135deg,#12326b 0%,#1f56b8 58%,#2f8bd6 100%);color:#fff}
.cover h1{margin:0 0 14px;font-size:30px;line-height:1.35;letter-spacing:.3px}
.meta{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:13px;color:rgba(255,255,255,.86)}
.meta b{color:#fff;font-weight:600}
.one-line{margin:22px 0 0;padding:14px 18px;border-radius:12px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28);font-size:15px;font-weight:600;color:#fff}
.body{padding:30px 44px 40px}
h2{font-size:17px;margin:30px 0 12px;padding-left:11px;border-left:4px solid #1f56b8;line-height:1.3}
h2:first-child{margin-top:0}
.overview{color:#39465c;background:#f5f8fd;border-radius:12px;padding:14px 16px;border:1px solid #e2eaf7}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.card{border:1px solid #e4e9f2;border-radius:12px;padding:13px 15px;background:#fbfcfe}
.card .idx{display:inline-flex;width:20px;height:20px;border-radius:50%;background:#1f56b8;color:#fff;font-size:12px;align-items:center;justify-content:center;margin-right:7px;font-weight:700}
.card p{margin:0;color:#26324a}
.decision{display:flex;gap:10px;align-items:flex-start;border:1px solid #d9eee2;background:#f4fbf7;border-radius:10px;padding:11px 14px;margin-bottom:9px}
.decision .tick{color:#178a4c;font-weight:800}
.risk{border:1px solid #f3e2c8;background:#fffaf1;border-radius:10px;padding:11px 14px;margin-bottom:9px}
.risk .tag{display:inline-block;font-size:11px;padding:0 7px;border-radius:999px;margin-right:8px;border:1px solid #d8a24b;color:#a26b14}
.risk.high{border-color:#f1c6c6;background:#fff6f6}
.risk.high .tag{border-color:#cf5b5b;color:#b23a3a}
.section{border-left:2px solid #dfe6f3;padding:2px 0 2px 16px;margin:0 0 18px}
.section h3{font-size:14px;margin:0 0 7px;color:#16305f}
.section ul{margin:0;padding-left:18px;color:#34415a}
.section li{margin:3px 0}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #e7ecf4;vertical-align:top}
th{background:#f5f8fd;color:#4a5972;font-weight:600;white-space:nowrap}
td.pushed{color:#178a4c;white-space:nowrap}
td.pending{color:#a26b14;white-space:nowrap}
.pri{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;background:#eef3fc;color:#2b5296}
.pri.high{background:#fdecec;color:#b23a3a}
.pri.low{background:#eef5ef;color:#38734f}
details{margin-top:8px;border:1px solid #e4e9f2;border-radius:12px;background:#fbfcfe}
summary{cursor:pointer;padding:12px 16px;font-weight:600;color:#33425c}
pre{white-space:pre-wrap;word-break:break-word;margin:0;padding:0 16px 18px;font-family:"SF Mono",Menlo,Consolas,monospace;font-size:12px;color:#44506a;max-height:520px;overflow:auto}
.foot{padding:16px 44px 26px;color:#8491a6;font-size:12px;border-top:1px solid #eef1f6}
@media print{body{background:#fff}.doc{box-shadow:none;margin:0;border-radius:0}.cover{-webkit-print-color-adjust:exact;print-color-adjust:exact}details{display:block}details>summary{list-style:none}pre{max-height:none}}
`

/**
 * Build the standalone HTML minutes document.
 * @param meeting - canonical meeting.
 */
export function buildHtml(meeting) {
  const summary = meeting.summary
  const progress = todoProgress(meeting)
  const coverMeta = [
    ['日期', meeting.date],
    ['参会人', meeting.attendees.length > 0 ? meeting.attendees.join('、') : '未填写'],
    ['来源', meeting.sourceType === 'recording' ? '录音转写' : meeting.sourceType === 'import' ? '导入记录' : '文本导入'],
    meeting.transcriptSeconds > 0 ? ['录音时长', formatDuration(meeting.transcriptSeconds)] : null,
    ['待办', progress.total === 0 ? '无' : `${progress.pushed}/${progress.total} 已写入日历`],
  ].filter((entry) => entry !== null)

  const parts = []
  parts.push('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">')
  parts.push('<meta name="viewport" content="width=device-width,initial-scale=1">')
  parts.push(`<title>${escapeHtml(meeting.title)} · 会议纪要</title>`)
  parts.push(`<style>${DOC_CSS}</style></head><body><div class="doc">`)
  parts.push('<div class="cover">')
  parts.push(`<h1>${escapeHtml(meeting.title)}</h1>`)
  parts.push('<div class="meta">')
  for (const [label, value] of coverMeta) {
    parts.push(`<span>${escapeHtml(label)}：<b>${escapeHtml(value)}</b></span>`)
  }
  parts.push('</div>')
  if (summary !== null && summary.oneLine !== '') {
    parts.push(`<div class="one-line">${escapeHtml(summary.oneLine)}</div>`)
  }
  parts.push('</div><div class="body">')

  if (summary === null) {
    parts.push('<h2>原始文本</h2>')
    parts.push(`<pre style="padding:0">${escapeHtml(meeting.transcript)}</pre>`)
  } else {
    if (summary.overview !== '') {
      parts.push('<h2>整体概述</h2>')
      parts.push(`<div class="overview">${escapeHtml(summary.overview)}</div>`)
    }
    if (summary.keyPoints.length > 0) {
      parts.push('<h2>关键要点</h2><div class="grid">')
      summary.keyPoints.forEach((point, index) => {
        parts.push(`<div class="card"><p><span class="idx">${index + 1}</span>${escapeHtml(point)}</p></div>`)
      })
      parts.push('</div>')
    }
    if (summary.decisions.length > 0) {
      parts.push('<h2>会议决策</h2>')
      for (const decision of summary.decisions) {
        const owner = decision.owner === '' ? '' : `<span style="color:#5c6a82;margin-left:6px">负责人：${escapeHtml(decision.owner)}</span>`
        parts.push(`<div class="decision"><span class="tick">✓</span><div>${escapeHtml(decision.text)}${owner}</div></div>`)
      }
    }
    if (summary.risks.length > 0) {
      parts.push('<h2>风险 / 待确认</h2>')
      for (const risk of summary.risks) {
        const level = risk.level === 'high' ? '高' : risk.level === 'low' ? '低' : '中'
        parts.push(`<div class="risk ${escapeHtml(risk.level)}"><span class="tag">${level}</span>${escapeHtml(risk.text)}</div>`)
      }
    }
    if (summary.sections.length > 0) {
      parts.push('<h2>分节纪要</h2>')
      for (const section of summary.sections) {
        parts.push(`<div class="section"><h3>${escapeHtml(section.heading)}</h3><ul>`)
        if (section.bullets.length === 0) parts.push('<li>（无）</li>')
        for (const bullet of section.bullets) parts.push(`<li>${escapeHtml(bullet)}</li>`)
        parts.push('</ul></div>')
      }
    }
    if (summary.todos.length > 0) {
      parts.push('<h2>待办事项</h2><table><thead><tr><th>状态</th><th>交付物</th><th>负责人</th><th>截止</th><th>优先级</th><th>备注</th></tr></thead><tbody>')
      for (const todo of summary.todos) {
        const pushed = todo.calendarTaskId !== null
        parts.push('<tr>')
        parts.push(`<td class="${pushed ? 'pushed' : 'pending'}">${pushed ? '已写入日历' : '待写入'}</td>`)
        parts.push(`<td>${escapeHtml(todo.title)}</td>`)
        parts.push(`<td>${escapeHtml(todo.owner || '—')}</td>`)
        parts.push(`<td>${escapeHtml(todo.due || '—')}</td>`)
        parts.push(`<td><span class="pri ${escapeHtml(todo.priority)}">${priorityLabel(todo.priority)}</span></td>`)
        parts.push(`<td>${escapeHtml(todo.notes || '—')}</td>`)
        parts.push('</tr>')
      }
      parts.push('</tbody></table>')
    }
    parts.push('<h2>原始转写</h2>')
    parts.push(`<details><summary>展开全文（${meeting.transcript.length} 字）</summary><pre>${escapeHtml(meeting.transcript)}</pre></details>`)
  }
  parts.push('</div>')
  parts.push(`<div class="foot">由 DeepSeek Harness 会议纪要插件生成 · ${escapeHtml(formatMoment(new Date()))}${summary === null ? '' : ` · 模型：${escapeHtml(summary.model || '未知')}`}</div>`)
  parts.push('</div></body></html>')
  return parts.join('\n')
}

/* ─────────────────────────── Word (.docx) ─────────────────────────── */

/** CRC32 table for the stored-ZIP writer below. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1)
    table[index] = value >>> 0
  }
  return table
})()

/** CRC32 of a buffer (ZIP entries need it even when stored uncompressed). */
function crc32(buffer) {
  let value = 0xFFFFFFFF
  for (let index = 0; index < buffer.length; index += 1) {
    value = CRC_TABLE[(value ^ buffer[index]) & 0xFF] ^ (value >>> 8)
  }
  return (value ^ 0xFFFFFFFF) >>> 0
}

/**
 * Minimal ZIP writer (store method, no compression).
 * Word accepts stored entries, and this avoids a zip dependency in the host half.
 */
function zipStore(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034B50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014B50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + data.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054B50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBuffer, end])
}

/** Escape text for OOXML text nodes. */
function xmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** One run with explicit Chinese/ASCII fonts (Word otherwise substitutes). */
function docxRun(textValue, options = {}) {
  const size = Number(options.size ?? 21)
  const rPr = [
    '<w:rPr>',
    '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/>',
    options.bold === true ? '<w:b/>' : '',
    options.color !== undefined ? '<w:color w:val="' + String(options.color) + '"/>' : '',
    '<w:sz w:val="' + String(Math.round(size * 2)) + '"/>',
    '<w:szCs w:val="' + String(Math.round(size * 2)) + '"/>',
    '</w:rPr>',
  ].join('')
  return '<w:r>' + rPr + '<w:t xml:space="preserve">' + xmlEscape(textValue) + '</w:t></w:r>'
}

/** One paragraph; options.align is left/center/right. */
function docxParagraph(textValue, options = {}) {
  const props = [
    '<w:pPr>',
    options.heading === true ? '<w:keepNext/>' : '',
    '<w:spacing w:before="' + String(options.before ?? 0) + '" w:after="' + String(options.after ?? 120) + '" w:line="' + String(options.line ?? 300) + '" w:lineRule="auto"/>',
    options.align !== undefined ? '<w:jc w:val="' + String(options.align) + '"/>' : '',
    options.indent === true ? '<w:ind w:firstLine="480"/>' : '',
    '</w:pPr>',
  ].join('')
  const runs = typeof textValue === 'string' ? docxRun(textValue, options) : textValue
  return '<w:p>' + props + runs + '</w:p>'
}

/** A table cell (borders come from the table-level tblBorders). */
function docxCell(textValue, options = {}) {
  const width = Number(options.width ?? 2000)
  return [
    '<w:tc>',
    '<w:tcPr><w:tcW w:w="' + String(width) + '" w:type="dxa"/>',
    options.header === true ? '<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>' : '',
    '<w:vAlign w:val="center"/></w:tcPr>',
    docxParagraph(textValue, { size: options.size ?? 18, bold: options.header === true, after: 40, line: 260 }),
    '</w:tc>',
  ].join('')
}

/** Build the Word document body for one meeting. */
function buildDocxBody(meeting) {
  const attendees = Array.isArray(meeting.attendees) ? meeting.attendees : []
  const transcript = typeof meeting.transcript === 'string' ? meeting.transcript : ''
  const summary = meeting.summary ?? null
  const todos = Array.isArray(summary?.todos) ? summary.todos : []
  const decisions = Array.isArray(summary?.decisions) ? summary.decisions : []
  const parts = []
  parts.push(docxParagraph(meeting.title || '会议纪要', { size: 22, bold: true, align: 'center', after: 120 }))
  const meta = [
    '会议日期：' + meeting.date,
    '来源：' + (meeting.sourceType === 'recording' ? '录音' : meeting.sourceType === 'import' ? '导入文件' : '文本'),
    '参会人：' + (attendees.length > 0 ? attendees.join('、') : '（未填写）'),
    '字数：' + String(transcript.length),
  ].join('　　')
  parts.push(docxParagraph(meta, { size: 18, align: 'center', after: 240, color: '595959' }))
  if (summary !== null) {
    if (summary.oneLine !== '') {
      parts.push(docxParagraph('一句话结论', { size: 16, bold: true, after: 60 }))
      parts.push(docxParagraph(summary.oneLine, { size: 21, after: 180 }))
    }
    if (summary.overview !== '') {
      parts.push(docxParagraph('概述', { size: 16, bold: true, after: 60 }))
      parts.push(docxParagraph(summary.overview, { size: 21, indent: true, after: 180 }))
    }
    if (decisions.length > 0) {
      parts.push(docxParagraph('决策事项', { size: 16, bold: true, after: 60 }))
      decisions.forEach((item, index) => {
        const owner = typeof item.owner === 'string' && item.owner !== '' ? '（负责人：' + item.owner + '）' : ''
        parts.push(docxParagraph(String(index + 1) + '. ' + String(item.text ?? '') + owner, { size: 21, after: 80 }))
      })
    }
  }
  parts.push(docxParagraph('待办事项', { size: 16, bold: true, after: 60 }))
  if (todos.length === 0) {
    parts.push(docxParagraph('（无）', { size: 21, after: 180 }))
  } else {
    const rows = [
      '<w:tr>' + docxCell('序号', { header: true, width: 700 }) + docxCell('待办事项', { header: true, width: 4200 }) + docxCell('负责人', { header: true, width: 1200 }) + docxCell('截止日期', { header: true, width: 1400 }) + '</w:tr>',
    ]
    todos.forEach((todo, index) => {
      rows.push('<w:tr>'
        + docxCell(String(index + 1), { width: 700 })
        + docxCell(String(todo.title ?? ''), { width: 4200 })
        + docxCell(todo.owner === '' ? '--' : String(todo.owner), { width: 1200 })
        + docxCell(todo.due === '' ? '--' : String(todo.due), { width: 1400 })
        + '</w:tr>')
    })
    parts.push('<w:tbl><w:tblPr><w:tblW w:w="7500" w:type="dxa"/><w:tblBorders>'
      + '<w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/>'
      + '<w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/>'
      + '<w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/>'
      + '</w:tblBorders></w:tblPr>' + rows.join('') + '</w:tbl>')
    parts.push(docxParagraph('', { after: 120 }))
  }
  if (transcript !== '') {
    parts.push(docxParagraph('原始转写', { size: 16, bold: true, before: 240, after: 60 }))
    for (const line of transcript.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      parts.push(docxParagraph(trimmed, { size: 19, after: 60, line: 280 }))
    }
  }
  return parts.join('')
}

/** Assemble the minimal OOXML package Word opens without repair. */
export function buildDocx(meeting) {
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:body>' + buildDocxBody(meeting)
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="1247" w:right="1247" w:bottom="1247" w:left="1247" w:header="720" w:footer="720" w:gutter="0"/>'
    + '</w:sectPr></w:body></w:document>'
  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:docDefaults><w:rPrDefault><w:rPr>'
    + '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/>'
    + '<w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault>'
    + '<w:pPrDefault><w:pPr><w:spacing w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '</w:styles>'
  return zipStore([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        + '</Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        + '</Relationships>',
    },
    {
      name: 'word/_rels/document.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        + '</Relationships>',
    },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: styles },
  ])
}

/** Resolve the export directory under the harness home. */
export function resolveExportDir(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  return join(home, 'meeting-minutes', 'exports')
}

/**
 * Render and persist one export.
 * @param meeting - canonical meeting.
 * @param format - `html` or `md`.
 * @param options - `dir` (override export directory).
 * @returns `{ format, filename, content, path }`.
 */
export async function exportMeeting(meeting, format = 'html', options = {}) {
  const kind = format === 'md' ? 'md' : format === 'docx' ? 'docx' : 'html'
  const filename = `${meeting.date}-${safeFileName(meeting.title)}.${EXTENSION[kind]}`
  const dir = options.dir ?? resolveExportDir()
  await mkdir(dir, { recursive: true })
  const path = join(dir, filename)
  if (kind === 'docx') {
    const buffer = buildDocx(meeting)
    await writeFile(path, buffer)
    return { format: kind, filename, path, base64: buffer.toString('base64') }
  }
  const content = kind === 'md' ? buildMarkdown(meeting) : buildHtml(meeting)
  await writeFile(path, content, 'utf8')
  return { format: kind, filename, content, path }
}
