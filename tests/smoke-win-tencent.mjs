/**
 * Windows 专项自测：腾讯会议「手动选择录制目录」+ 目录扫描 + 跨平台转码/文档解析。
 *
 * 覆盖：
 *   1) AUTO_INGEST 配置里的 tencentDir（默认空、可保存）
 *   2) Windows 默认录制目录探测（文档\\TencentMeeting）与手动目录优先级
 *   3) 目录模式扫描：腾讯会议按「账号/会议」分子目录，最多 3 层、去重、数量上限
 *   4) docx 跨平台解析（不依赖 /usr/bin/unzip，Windows 也能导入）
 *   5) 非 16k WAV 用 ffmpeg 转码（Windows 没有 afconvert）
 *
 * 用法：node tests/smoke-win-tencent.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'src', 'lib')
const imp = (file) => import(pathToFileURL(path.join(SRC, file)).href)

let failures = 0
function check(label, condition, detail) {
  const ok = !!condition
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  :: ' + detail}`)
}
function skip(label, detail) {
  console.log(`SKIP  ${label}${detail === undefined ? '' : '  :: ' + detail}`)
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-win-'))
const oldTime = new Date(Date.now() - 10 * 60 * 1000)

/* ── 测试用 ZIP（docx）构造：store 方式，不压缩 ─────────────────── */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8')
    const data = Buffer.from(text, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30 + nameBytes.length + data.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(0, 10)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    nameBytes.copy(local, 30)
    data.copy(local, 30 + nameBytes.length)
    locals.push(local)
    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(0, 12)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    nameBytes.copy(central, 46)
    centrals.push(central)
    offset += local.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(centrals.length, 8)
  eocd.writeUInt16LE(centrals.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBuffer, eocd])
}

/* ── 1. 配置归一化 ─────────────────────────────────────────────── */
const { DEFAULT_AUTO_INGEST, normalizeAutoIngestConfig } = await imp('model.js')
check('默认腾讯会议目录为空（自动探测）', DEFAULT_AUTO_INGEST.tencentDir === '')
check('tencentDir 可保存并回读', normalizeAutoIngestConfig({ tencentDir: 'C:\\Users\\me\\Documents\\TencentMeeting' }).tencentDir === 'C:\\Users\\me\\Documents\\TencentMeeting')
check('缺失 tencentDir 时归一化为空串', normalizeAutoIngestConfig({ dirs: [] }).tencentDir === '')
check('tencent 默认为关闭（不自动解析腾讯会议）', DEFAULT_AUTO_INGEST.tencent === false && normalizeAutoIngestConfig({ dirs: [] }).tencent === false)
check('dirsEnabled 默认为关闭（不自动扫描自定义目录）', DEFAULT_AUTO_INGEST.dirsEnabled === false && normalizeAutoIngestConfig({ dirs: [] }).dirsEnabled === false)
check('dirsEnabled 可打开并回读', normalizeAutoIngestConfig({ dirsEnabled: true }).dirsEnabled === true)
check('dirsEnabled 可关闭并回读', normalizeAutoIngestConfig({ dirsEnabled: false }).dirsEnabled === false)

/* ── 2. 目录探测 ───────────────────────────────────────────────── */
const { defaultTencentDirs, resolveTencentDir, readDocxText, readZipEntry } = await imp('autoingest.js')
const defaults = defaultTencentDirs()
const documentsTencent = path.join(os.homedir(), 'Documents', 'TencentMeeting')
check('默认探测包含「文档\\TencentMeeting」', defaults.some((dir) => dir.toLowerCase() === documentsTencent.toLowerCase()), defaults.join(' | '))
const manual = path.join(tmpRoot, '手动选择的腾讯目录')
fs.mkdirSync(manual, { recursive: true })
check('手动目录优先于自动探测', resolveTencentDir({ tencentDir: manual }).source === 'config' && resolveTencentDir({ tencentDir: manual }).dir === manual)
check('空配置时不报错（source=none/detected）', ['none', 'detected'].includes(resolveTencentDir({ tencentDir: '' }).source))

/* ── 3. docx 跨平台解析 ───────────────────────────────────────── */
const docxPath = path.join(tmpRoot, '腾讯会议纪要.docx')
fs.writeFileSync(docxPath, buildZip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
  'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>腾讯会议导出的纪要内容</w:t></w:r></w:p><w:p><w:r><w:t>第二段：下周继续</w:t></w:r></w:p></w:body></w:document>',
}))
const docxText = await readDocxText(docxPath)
check('docx 正文可解析（不依赖 unzip）', docxText.includes('腾讯会议导出的纪要内容') && docxText.includes('第二段'), docxText.replace(/\n/g, ' / '))
check('readZipEntry 可直接取 entry', readZipEntry(fs.readFileSync(docxPath), 'word/document.xml')?.length > 0)

/* ── 4. 目录模式扫描（真 store + 假 ASR） ────────────────────── */
const { MeetingStore } = await imp('store.js')
const { createAutoIngest } = await imp('autoingest.js')
const home = path.join(tmpRoot, 'dsh-home')
process.env.DSH_HOME = home
const store = new MeetingStore({ logger: { info: () => {}, warn: () => {}, error: () => {} } })
await store.load()
const ingest = createAutoIngest({
  store,
  asr: { transcribeFile: async () => ({ text: '腾讯会议录制的转写内容', audioSeconds: 8, inferenceSeconds: 0.1 }) },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
})

const tencentRoot = path.join(tmpRoot, '记录', '腾讯会议')
const nested = path.join(tencentRoot, '账号A', '2026-11-13 产品周会')
fs.mkdirSync(nested, { recursive: true })
const audioFile = path.join(nested, '录制.mp4')
const textFile = path.join(nested, '会议纪要.txt')
fs.writeFileSync(audioFile, 'fake-mp4-bytes')
fs.writeFileSync(textFile, '这是从腾讯会议目录导入的文本纪要。')
const nestedDocx = path.join(tencentRoot, '账号A', '2026-11-12 复盘')
fs.mkdirSync(nestedDocx, { recursive: true })
const docxInDir = path.join(nestedDocx, '复盘.docx')
fs.copyFileSync(docxPath, docxInDir)
// 让三个文件“已经写完”（>45 秒），并给出确定的先后顺序
fs.utimesSync(docxInDir, oldTime, oldTime)
fs.utimesSync(textFile, new Date(oldTime.getTime() + 60_000), new Date(oldTime.getTime() + 60_000))
fs.utimesSync(audioFile, new Date(oldTime.getTime() + 120_000), new Date(oldTime.getTime() + 120_000))

await ingest.setConfig({ enabled: true, tencent: true, tencentDir: tencentRoot, dirs: [tencentRoot] })
let status = ingest.status()
check('状态显示手动选择的目录', status.tencentDir === tencentRoot && status.tencentDirSource === 'config', JSON.stringify({ dir: status.tencentDir, source: status.tencentDirSource }))

await ingest.scanNow()
check('第一次扫描（每轮最多 2 个）导入 2 场', store.snapshot().meetings.length === 2, String(store.snapshot().meetings.length))
await ingest.scanNow()
status = ingest.status()
const meetings = store.snapshot().meetings
check('第二次扫描补齐第 3 场', meetings.length === 3, meetings.map((m) => m.title).join(' / '))
check('音频被识别成会议（mp4 → ASR）', meetings.some((m) => m.title === '录制' && m.transcript.includes('腾讯会议录制的转写内容')))
check('txt 直接导入文本', meetings.some((m) => m.title === '会议纪要' && m.transcript.includes('从腾讯会议目录导入')))
check('docx 在目录模式下也能导入', meetings.some((m) => m.title === '复盘' && m.transcript.includes('腾讯会议导出的纪要内容')))
check('状态为目录模式且来源是手动目录', status.tencentMode === 'directory' && status.tencentAvailable === true && status.tencentDirPath === tencentRoot, JSON.stringify({ mode: status.tencentMode, path: status.tencentDirPath }))
check('扫描到 3 个候选文件', status.tencentRecords === 3, String(status.tencentRecords))
await ingest.scanNow()
check('重复扫描不会重复导入', store.snapshot().meetings.length === 3, String(store.snapshot().meetings.length))

await ingest.setConfig({ tencentDir: path.join(tmpRoot, '不存在目录'), dirs: [] })
await ingest.scanNow()
status = ingest.status()
check('目录不存在时状态给出中文提示', status.tencentAvailable === false && String(status.tencentError).includes('不存在'), status.tencentError)

/* ── 4.1 自定义监控目录的独立开关（dirsEnabled） ──────────────── */
const extraDir = path.join(tmpRoot, '自定义监控')
fs.mkdirSync(extraDir, { recursive: true })
const extraFile = path.join(extraDir, '手动放入的会议.txt')
fs.writeFileSync(extraFile, '这是放进自定义监控目录的文本纪要。', 'utf8')
fs.utimesSync(extraFile, oldTime, oldTime)
const beforeSwitch = store.snapshot().meetings.length
await ingest.setConfig({ tencent: false, tencentDir: '', dirsEnabled: false, dirs: [extraDir] })
await ingest.scanNow()
check('关闭自定义监控后不导入新文件', store.snapshot().meetings.length === beforeSwitch, String(store.snapshot().meetings.length))
status = ingest.status()
check('状态回报自定义监控目录已关闭', status.dirsEnabled === false && status.tencent === false, JSON.stringify({ dirsEnabled: status.dirsEnabled, tencent: status.tencent }))
await ingest.setConfig({ dirsEnabled: true })
await ingest.scanNow()
check('打开自定义监控后能导入', store.snapshot().meetings.length === beforeSwitch + 1, store.snapshot().meetings.map((m) => m.title).join(' / '))
await ingest.setConfig({ tencent: true, tencentDir: path.join(tmpRoot, '不存在目录') })
check('两个开关互不影响', ingest.status().tencent === true && ingest.status().dirsEnabled === true)

/* ── 5. 非 16k WAV 用 ffmpeg 转码 ─────────────────────────────── */
const { createAsr, findFfmpeg } = await imp('asr.js')
const ffmpeg = await findFfmpeg()
if (ffmpeg === null) {
  skip('ffmpeg 转码（本机未安装 ffmpeg）')
} else {
  check('找到 ffmpeg', typeof ffmpeg === 'string', ffmpeg)
  // 44.1kHz 双声道 PCM16 WAV：不是 16k 单声道，必须转码
  const sampleRate = 44100
  const frames = sampleRate * 1
  const data = Buffer.alloc(frames * 4)
  for (let index = 0; index < frames; index += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 8000)
    data.writeInt16LE(sample, index * 4)
    data.writeInt16LE(sample, index * 4 + 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(2, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 4, 28)
  header.writeUInt16LE(4, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  const wavPath = path.join(tmpRoot, '44k-stereo.wav')
  fs.writeFileSync(wavPath, Buffer.concat([header, data]))

  const fakeSpeech = {
    snapshot() {
      return {
        providers: [{ id: 'fake', name: 'Fake ASR', preparation: { phase: 'ready' }, languages: ['zh'] }],
        selection: { providerId: 'fake', language: 'zh' },
      }
    },
    async resolve({ audio }) {
      return { audio }
    },
    async transcribe() {
      return { text: '转换后识别成功', audioSeconds: 1, inferenceSeconds: 0.01 }
    },
  }
  const asr = createAsr({ ctx: { get: (name) => (name === 'speechToText' ? fakeSpeech : undefined) } })
  try {
    const result = await asr.transcribeFile(wavPath, { language: 'zh' })
    check('44.1kHz 双声道 WAV 转码后可识别', result.text === '转换后识别成功', JSON.stringify(result))
  } catch (error) {
    check('44.1kHz 双声道 WAV 转码后可识别', false, String(error?.message ?? error))
  }
}

fs.rmSync(tmpRoot, { recursive: true, force: true })
if (failures === 0) console.log('\nALL WINDOWS TEN-CENT CHECKS PASSED')
else console.log(`\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

