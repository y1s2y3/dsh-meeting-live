/**
 * 离线测试：文件夹术语提取（不联网、不调用真实模型）
 *   - 设置归一化：术语列表去重/排序/最多 50 个、旧数据兼容
 *   - effectiveTerms：文件夹术语优先 + 手动术语补充
 *   - term-extract：读取 txt/md/json/docx、递归目录、跳过不支持文件
 *   - prompt：必须要求最多 50 个、按 priority 排序、只抽专有名词
 *   - 前端：设置页包含解析/重新解析/删除入口
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

/* 1. 术语列表归一化 */
{
  const raw = [
    { text: '智慧工地平台', category: '产品/系统', priority: 3, count: 5 },
    { text: '张三', category: '人名', priority: 1, count: 2 },
    { text: '智慧工地平台', priority: 2, count: 9 }, // 重复
    { text: 'A', priority: 4 }, // 太短
    { text: 'BIM技术', category: '不存在的分类', priority: 'x' },
  ];
  const items = settings.normalizeTermItems(raw);
  check('术语去重', items.length === 3, items.map((item) => item.text).join(','));
  check('按 priority 排序并重排为 1..N', items[0].text === '张三' && items[0].priority === 1 && items[1].text === '智慧工地平台' && items[2].text === 'BIM技术', JSON.stringify(items.map((item) => item.priority + ':' + item.text)));
  check('非法分类回退为「术语」', items[2].category === '术语', items[2].category);
  const many = settings.normalizeTermItems(Array.from({ length: 80 }, (all, index) => ({ text: '术语' + String(index), priority: index + 1 })));
  check('最多保留 50 个', many.length === 50, String(many.length));
}

/* 2. 文件夹提取结果归一化 + 旧数据兼容 */
{
  const empty = settings.normalizeSettings({});
  check('默认设置含空的文件夹术语结构', empty.termExtract.dir === '' && Array.isArray(empty.termExtract.items) && empty.termExtract.items.length === 0);
  const noDir = settings.normalizeTermExtract({ dir: '', items: [{ text: '张三' }] });
  check('没有目录时丢弃术语（避免误用上次文件夹）', noDir.items.length === 0);
  const withStats = settings.normalizeTermExtract({ dir: 'D:\\会议资料', at: '2026-11-17T02:00:00.000Z', items: [{ text: '张三', priority: 2 }, { text: '智慧工地平台', priority: 1 }], stats: { files: 5, supported: 3, skipped: 2, chars: 1200, truncated: true } });
  check('保留目录与解析时间', withStats.dir === 'D:\\会议资料' && withStats.at !== '');
  check('保留统计信息', withStats.stats.supported === 3 && withStats.stats.skipped === 2 && withStats.stats.truncated === true, JSON.stringify(withStats.stats));
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

/* 4. 文件夹扫描：txt / md / json / docx / 子目录 / 不支持文件 */
{
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-terms-scan-'));
  fs.mkdirSync(path.join(folder, '子目录'));
  fs.writeFileSync(path.join(folder, '会议纪要.txt'), '智慧工地平台由张三负责，二期继续用 BIM 模型。', 'utf8');
  fs.writeFileSync(path.join(folder, '方案.md'), '# 方案\n\n智慧工地平台二期涉及进度计划与验收标准。', 'utf8');
  fs.writeFileSync(path.join(folder, '子目录', '名单.json'), '{"name":"张三","project":"智慧工地平台"}', 'utf8');
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
  check('支持 txt/md/json/docx', scanned.stats.supported >= 4, JSON.stringify(scanned.stats));
  check('跳过不支持的 png/mp3/doc', scanned.stats.skipped >= 3, JSON.stringify(scanned.stats));
  check('递归读取子目录', scanned.text.includes('名单') || scanned.text.includes('"project"') || scanned.text.includes('progress'), '');
  check('Word 正文被解析为文本', scanned.text.includes('验收标准'), '');
  fs.rmSync(folder, { recursive: true, force: true });
}

/* 5. 空目录 / 不存在的目录给出中文错误 */
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-terms-empty-'));
  const scanned = await terms.scanFolder(empty);
  check('空目录返回空文本（由路由提示）', scanned.text === '' && scanned.stats.supported === 0);
  fs.rmSync(empty, { recursive: true, force: true });
  let message = '';
  try { await terms.scanFolder(path.join(os.tmpdir(), 'dsh-terms-not-exist-' + Date.now())); } catch (error) { message = String(error?.message ?? error); }
  check('不存在的目录报中文错误', message.includes('文件夹不存在'), message);
}

/* 6. 模型 prompt 约束 */
{
  const prompt = summarize.TERM_EXTRACT_PROMPT;
  check('prompt 要求最多 50 个', prompt.includes('最多 50 个'));
  check('prompt 要求 priority 排序', prompt.includes('priority') && prompt.includes('1 最重要'));
  check('prompt 限制分类与通用词', prompt.includes('产品/系统') && prompt.includes('人名') && prompt.includes('通用词'));
  const userPrompt = summarize.buildTermUserPrompt('智慧工地平台', { supported: 3, chars: 1000, names: ['a.txt', 'b.docx'], truncated: true });
  check('用户消息包含文件统计与内容', userPrompt.includes('3 个文件') && userPrompt.includes('智慧工地平台') && userPrompt.includes('部分内容'));
}

/* 7. 前端入口与路由 */
{
  const client = fs.readFileSync(path.join(repo, 'src', 'lib', 'client.js'), 'utf8');
  check('设置页有文件夹术语入口', client.includes('从文件夹提取术语') && client.includes("requestJson('/terms/extract'"));
  check('支持重新解析 / 逐个删除 / 清空', client.includes('重新解析') && client.includes('removeTermItem') && client.includes('clearTermItems') && client.includes('dsm-term-del'));
  check('术语复用系统文件夹选择', client.includes("'/dialog/pick-dir'"));
  const server = fs.readFileSync(path.join(repo, 'src', 'lib', 'server.js'), 'utf8');
  check('宿主提供 /terms/extract 路由', server.includes("segments[1] === 'extract'") && server.includes('extractTerms'));
  check('纠错使用合并后的术语', server.includes('effectiveTerms(settingsNow)') && !server.includes('parseTerms(settingsNow.terms)'));
}

console.log(failures === 0 ? '\nALL TERM TESTS PASSED' : `\n${failures} TERM TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
