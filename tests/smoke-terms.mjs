/**
 * 离线测试：文件夹术语提取（不联网、不调用真实模型）
 *   - 设置归一化：术语去重/排序/最多 50 个、多文件夹、旧 dir 字段迁移
 *   - effectiveTerms：文件夹术语优先 + 手动术语补充
 *   - term-extract：txt/md/json/docx/xlsx/pdf、递归目录、多文件夹合并、跳过不支持文件
 *   - prompt：最多 50 个、按 priority 排序、只抽专有名词
 *   - 前端：多文件夹、预览勾选、重新解析、编辑/排序、逐个删除
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (file) => import(pathToFileURL(path.join(repo, 'src', 'lib', file)).href);
const settings = await imp('settings.js');
const terms = await imp('term-extract.js');
const summarize = await imp('summarize.js');
const { buildDocx } = await imp('export.js');

let failures = 0;
function check(label, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ← ' + detail}`);
  if (!condition) failures += 1;
}

/** 手写最小 ZIP（store 模式），用来生成一个带共享字符串的 .xlsx 测试文件。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buffer) {
  let c = 0xFFFFFFFF;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBytes.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuffer, end]);
}
function makeXlsx() {
  return zipStore({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/sharedStrings.xml': '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>智慧工地平台</t></si><si><r><t>实名</t></r><r><t>制</t></r></si><si><t>BIM 模型</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>张三</t></is></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>',
  });
}

/* 1. 术语列表归一化 */
{
  const raw = [
    { text: '智慧工地平台', category: '产品/系统', priority: 3, count: 5 },
    { text: '张三', category: '人名', priority: 1, count: 2 },
    { text: '智慧工地平台', priority: 2, count: 9 },
    { text: 'A', priority: 4 },
    { text: 'BIM技术', category: '不存在的分类', priority: 'x' },
  ];
  const items = settings.normalizeTermItems(raw);
  check('术语去重', items.length === 3, items.map((item) => item.text).join(','));
  check('按 priority 排序并重排为 1..N', items[0].text === '张三' && items[0].priority === 1 && items[1].text === '智慧工地平台' && items[2].text === 'BIM技术', JSON.stringify(items.map((item) => item.priority + ':' + item.text)));
  check('非法分类回退为「术语」', items[2].category === '术语', items[2].category);
  const many = settings.normalizeTermItems(Array.from({ length: 80 }, (all, index) => ({ text: '术语' + String(index), priority: index + 1 })));
  check('最多保留 50 个', many.length === 50, String(many.length));
}

/* 2. 文件夹提取结果归一化：多文件夹 + 旧 dir 迁移 + 旧数据兼容 */
{
  const empty = settings.normalizeSettings({});
  check('默认设置含空的文件夹术语结构', empty.termExtract.dirs.length === 0 && Array.isArray(empty.termExtract.items));
  const noDir = settings.normalizeTermExtract({ dirs: [], items: [{ text: '张三' }] });
  check('删除文件夹后已保存术语保留（删文件夹≠删术语）', noDir.items.length === 1);
  const withStats = settings.normalizeTermExtract({ dirs: ['D:\\会议资料', 'E:\\项目文档'], at: '2026-11-17T02:00:00.000Z', items: [{ text: '张三', priority: 2 }, { text: '智慧工地平台', priority: 1 }], stats: { folders: 2, files: 5, supported: 3, skipped: 2, chars: 1200, truncated: true } });
  check('保留多个目录与解析时间', withStats.dirs.length === 2 && withStats.at !== '');
  check('保留统计信息（含文件夹数）', withStats.stats.folders === 2 && withStats.stats.supported === 3 && withStats.stats.skipped === 2 && withStats.stats.truncated === true, JSON.stringify(withStats.stats));
  const migrated = settings.normalizeTermExtract({ dir: 'D:\\旧目录', items: [{ text: '张三' }] });
  check('旧版单目录字段自动迁移为 dirs', migrated.dirs.length === 1 && migrated.dirs[0] === 'D:\\旧目录' && migrated.items.length === 1, JSON.stringify(migrated.dirs));
}

/* 3. effectiveTerms：文件夹术语优先，手动术语补充并去重 */
{
  const list = settings.effectiveTerms({
    termExtract: { items: [{ text: '张三' }, { text: '智慧工地平台' }] },
    terms: 'BIM\n智慧工地平台\n进度计划',
  });
  check('文件夹术语排在前面', list[0] === '张三' && list[1] === '智慧工地平台', JSON.stringify(list));
  check('手动术语补充且去重', list.includes('BIM') && list.includes('进度计划') && list.filter((item) => item === '智慧工地平台').length === 1, JSON.stringify(list));
  check('术语总数有上限', settings.effectiveTerms({ termExtract: { items: Array.from({ length: 50 }, (all, index) => ({ text: 'X' + String(index) })) }, terms: Array.from({ length: 100 }, (all, index) => 'Y' + String(index)).join('\n') }).length <= 120);
}

/* 4. 文件夹扫描：txt / md / json / docx / xlsx / pdf / 子目录 / 不支持文件 / 多文件夹合并 */
{
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-terms-scan-'));
  fs.mkdirSync(path.join(folder, '子目录'));
  fs.writeFileSync(path.join(folder, '会议纪要.txt'), '智慧工地平台由张三负责，二期继续用 BIM 模型。', 'utf8');
  fs.writeFileSync(path.join(folder, '方案.md'), '# 方案\n\n智慧工地平台二期涉及进度计划与验收标准。', 'utf8');
  fs.writeFileSync(path.join(folder, '子目录', '名单.json'), '{"name":"张三","project":"智慧工地平台"}', 'utf8');
  fs.writeFileSync(path.join(folder, '台账.xlsx'), makeXlsx());
  fs.writeFileSync(path.join(folder, '样例.pdf'), fs.readFileSync(path.join(repo, 'tests', 'fixtures', 'term-sample.pdf')));
  fs.writeFileSync(path.join(folder, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  fs.writeFileSync(path.join(folder, '旧格式.doc'), 'not supported');
  fs.writeFileSync(path.join(folder, '录音.mp3'), Buffer.alloc(32));
  const meeting = {
    title: '术语测试会议', date: '2026-11-17', sourceType: 'recording', attendees: ['张三'],
    transcript: '张三：智慧工地平台的验收标准需要再确认。',
    summary: {
      oneLine: '确认智慧工地平台二期验收标准。',
      overview: '本次会议讨论智慧工地平台二期的验收标准与进度计划。',
      keyPoints: ['智慧工地平台二期继续用 BIM 模型'],
      decisions: [{ text: '采用智慧工地平台二期方案', rationale: '与一期保持一致', owner: '张三' }],
      risks: [], sections: [{ heading: '验收标准', summary: '确认验收标准。', bullets: ['BIM 模型交付'] }],
      openQuestions: [], speakerSummaries: [{ speaker: 'S1', summary: '张三介绍进度计划' }],
      attendees: ['张三'], todos: [],
    },
  };
  fs.writeFileSync(path.join(folder, '会议纪要.docx'), Buffer.from(buildDocx(meeting)));
  const scanned = await terms.scanFolder(folder);
  check('扫描读到文本内容', scanned.text.includes('智慧工地平台') && scanned.text.includes('张三'), scanned.text.slice(0, 80));
  check('支持 txt/md/json/docx/xlsx/pdf', scanned.stats.supported >= 6, JSON.stringify(scanned.stats));
  check('跳过不支持的 png/mp3/doc', scanned.stats.skipped >= 3, JSON.stringify(scanned.stats));
  check('递归读取子目录', scanned.names.some((name) => name.includes('子目录')), scanned.names.join(','));
  check('Word 正文被解析为文本', scanned.text.includes('验收标准'), '');
  check('Excel 共享字符串被解析', scanned.text.includes('智慧工地平台\t实名制') || (scanned.text.includes('智慧工地平台') && scanned.text.includes('实名制')), '');
  check('PDF 文本层被解析', scanned.text.includes('术语样例') || scanned.text.includes('智慧工地平台二期'), scanned.text.includes('术语样例') ? '含标题' : '来自正文');

  /* 中文目录：Windows 上常见路径（机场平台2期），必须能正常读取 */
  const chineseParent = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-terms-cn-'));
  const chineseFolder = path.join(chineseParent, '机场平台2期');
  fs.mkdirSync(chineseFolder);
  fs.writeFileSync(path.join(chineseFolder, '周会纪要.txt'), '机场扩建指挥部：智慧工地平台二期讨论实名制与旁站记录。', 'utf8');
  const chineseScanned = await terms.scanFolder(chineseFolder);
  check('中文目录名可以正常扫描', chineseScanned.text.includes('智慧工地平台') && chineseScanned.stats.supported === 1, JSON.stringify(chineseScanned.stats));
  let garbledMessage = '';
  try { await terms.scanFolder('C:\\Users\\13065\\Desktop\\' + '\uFFFD\uFFFDƽ̨2\uFFFD'); } catch (error) { garbledMessage = String(error?.message ?? error); }
  check('乱码路径给出可操作的中文提示', garbledMessage.includes('乱码') && garbledMessage.includes('重新'), garbledMessage);
  fs.rmSync(chineseParent, { recursive: true, force: true });

  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-terms-scan2-'));
  fs.writeFileSync(path.join(second, '补充.txt'), '旁站记录由监理单位补齐，材料进场验收走数据中台。', 'utf8');
  const merged = await terms.scanFolders([folder, second]);
  check('多文件夹合并成功', merged.stats.folders === 2 && merged.text.includes('文件夹：') && merged.text.includes('旁站记录'), JSON.stringify(merged.stats));
  check('多文件夹统计合并', merged.stats.supported >= 7 && merged.stats.skipped >= 3, JSON.stringify(merged.stats));
  check('多文件夹文件名带文件夹前缀', merged.names.some((name) => name.includes('补充.txt')), merged.names.slice(0, 3).join(','));
  fs.rmSync(folder, { recursive: true, force: true });
  fs.rmSync(second, { recursive: true, force: true });
}

/* 5. 空目录 / 不存在目录 / 空文件夹列表都给出中文错误 */
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-terms-empty-'));
  const scanned = await terms.scanFolder(empty);
  check('空目录返回空文本（由路由提示）', scanned.text === '' && scanned.stats.supported === 0);
  fs.rmSync(empty, { recursive: true, force: true });
  let message = '';
  try { await terms.scanFolder(path.join(os.tmpdir(), 'dsh-terms-not-exist-' + Date.now())); } catch (error) { message = String(error?.message ?? error); }
  check('不存在的目录报中文错误', message.includes('文件夹不存在'), message);
  let listMessage = '';
  try { await terms.scanFolders([]); } catch (error) { listMessage = String(error?.message ?? error); }
  check('空文件夹列表报中文错误', listMessage.includes('请先选择'), listMessage);
}

/* 6. PDF / xlsx 解析器细节 */
{
  let pdfMessage = '';
  try { terms.pdfToText(Buffer.from('not a pdf')); } catch (error) { pdfMessage = String(error?.message ?? error); }
  check('非 PDF 不崩溃', terms.pdfToText(Buffer.from('not a pdf')) === '');
  const xlsxText = terms.xlsxToText(makeXlsx());
  check('xlsx 单元格按行列输出', xlsxText === '智慧工地平台\t实名制\n张三\t42', JSON.stringify(xlsxText));
  check('PDF 加密/无文本层时返回空字符串', terms.pdfToText(Buffer.from('%PDF-1.4 /Encrypt 1 0 R')) === '');
}

/* 7. 模型 prompt 约束 */
{
  const prompt = summarize.TERM_EXTRACT_PROMPT;
  check('prompt 要求最多 50 个', prompt.includes('最多 50 个'));
  check('prompt 要求 priority 排序', prompt.includes('priority') && prompt.includes('1 最重要'));
  check('prompt 限制分类与通用词', prompt.includes('产品/系统') && prompt.includes('人名') && prompt.includes('通用词'));
  const userPrompt = summarize.buildTermUserPrompt('智慧工地平台', { supported: 3, chars: 1000, names: ['a.txt', 'b.docx'], truncated: true });
  check('用户消息包含文件统计与内容', userPrompt.includes('3 个文件') && userPrompt.includes('智慧工地平台') && userPrompt.includes('部分内容'));
}

/* 8. 前端入口与路由 */
{
  const client = fs.readFileSync(path.join(repo, 'src', 'lib', 'client.js'), 'utf8');
  check('设置页有文件夹术语入口', client.includes('从文件夹提取术语') && client.includes("requestJson('/terms/extract'"));
  check('支持多文件夹（列表 + 添加/移除）', client.includes('dsm-term-folders') && client.includes('addTermDir') && client.includes('removeTermDir'));
  check('解析后先预览勾选再保存', client.includes('解析预览') && client.includes('保留勾选的') && client.includes('togglePreviewItem') && client.includes('confirmPreview'));
  check('支持重新解析 / 编辑 / 排序 / 删除 / 清空', client.includes("'重新解析'") && client.includes('startTermEdit') && client.includes('moveTermItem') && client.includes('removeTermItem') && client.includes('clearTermItems'));
  check('术语复用系统文件夹选择', client.includes("'/dialog/pick-dir'"));
  const server = fs.readFileSync(path.join(repo, 'src', 'lib', 'server.js'), 'utf8');
  check('宿主提供 /terms/extract 路由（返回预览）', server.includes("segments[1] === 'extract'") && server.includes('extractTerms') && server.includes('preview:'));
  check('纠错使用合并后的术语', server.includes('effectiveTerms(settingsNow)') && !server.includes('parseTerms(settingsNow.terms)'));
  check('术语提取支持多文件夹扫描', server.includes('scanFolders(dirs)'));
}

console.log(failures === 0 ? '\nALL TERM TESTS PASSED' : `\n${failures} TERM TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
