import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* 详细纪要回归：参考腾讯会议/通义听悟的结构——
   概述更长、章节带摘要、关键词、决策依据、风险建议、待确认问题、发言人总结。
   覆盖：数据规范化（新字段 + 旧数据兼容）、prompt 要求、导出 Markdown/HTML/Word。 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (file) => import(pathToFileURL(path.join(root, 'src', 'lib', file)).href);
const { normalizeSummary } = await imp('model.js');
const { SYSTEM_PROMPT, buildUserPrompt } = await imp('summarize.js');
const { buildMarkdown, buildHtml, buildDocx } = await imp('export.js');

let failures = 0;
function check(name, passed, detail) {
  if (passed) {
    console.log('[OK] ' + name);
  } else {
    failures += 1;
    console.log('[FAIL] ' + name + (detail === undefined ? '' : ' → ' + JSON.stringify(detail)));
  }
}

/* 1. 旧数据（只有旧字段）不能崩，新字段默认为空 */
{
  const legacy = normalizeSummary({
    oneLine: '旧版一句话结论',
    overview: '旧版概述',
    keyPoints: ['要点'],
    decisions: ['决定 A'],
    risks: [{ text: '风险', level: 'high' }],
    sections: [{ heading: '章节', bullets: ['要点 1'] }],
    attendees: ['张三'],
    todos: [{ title: '跟进', owner: '张三', due: '2026-01-01', priority: 'high', notes: '' }],
  });
  check('旧数据可规范化', legacy !== null && legacy.oneLine === '旧版一句话结论');
  check('旧数据缺少新字段时给空数组', Array.isArray(legacy.keywords) && legacy.keywords.length === 0
    && Array.isArray(legacy.openQuestions) && legacy.openQuestions.length === 0
    && Array.isArray(legacy.speakerSummaries) && legacy.speakerSummaries.length === 0);
  check('旧决策/风险补空依据与建议', legacy.decisions[0].rationale === '' && legacy.risks[0].suggestion === '');
  check('旧章节没有摘要字段时不报错', legacy.sections[0].summary === '' && legacy.sections[0].heading === '章节');
}

/* 2. 新结构字段全部保留 */
{
  const rich = normalizeSummary({
    oneLine: '结论',
    overview: ['第一段背景。', '', '第二段讨论。', '', '第三段结论。'].join(String.fromCharCode(10)),
    keyPoints: ['要点 A（含数字 30%）'],
    keywords: ['预算', '上线排期', '风控'],
    decisions: [{ text: '决定上线时间', owner: '李四', rationale: '因为客户档期在 3 月' }],
    risks: [{ text: '迁移风险', level: 'high', suggestion: '先灰度 10%' }],
    sections: [{ heading: '预算评审', summary: '本节确认了预算上限与分摊方式。', bullets: ['预算上限 200 万', '按季度分摊'] }],
    openQuestions: ['历史数据由谁负责迁移？'],
    speakerSummaries: [{ speaker: 'S1', summary: '关注排期与资源。' }],
    attendees: ['张三', '李四'],
    todos: [{ title: '输出迁移方案', owner: '王五', due: '2026-02-01', priority: 'normal', notes: '含回滚方案' }],
  });
  check('关键词保留', rich.keywords.length === 3 && rich.keywords[1] === '上线排期');
  check('概述支持多段', rich.overview.includes('\n\n'));
  check('决策带依据', rich.decisions[0].rationale === '因为客户档期在 3 月');
  check('风险带建议', rich.risks[0].suggestion === '先灰度 10%');
  check('章节带摘要', rich.sections[0].summary === '本节确认了预算上限与分摊方式。');
  check('待确认问题保留', rich.openQuestions.length === 1);
  check('发言人总结保留', rich.speakerSummaries[0].speaker === 'S1' && rich.speakerSummaries[0].summary.includes('排期'));
  // 模型把 400+ 字概述写成一整段时，规范化应自动切成 2 段以上
  const longSingle = normalizeSummary({ overview: '一'.repeat(120) + '。' + '二'.repeat(120) + '。' + '三'.repeat(120) + '。' });
  check('长单段概述自动分段', longSingle.overview.split('\n\n').filter((item) => item !== '').length >= 2, longSingle.overview.split('\n\n').map((item) => item.length));
}

/* 3. prompt 必须要求「详细结构」而不是一句话总结 */
{
  check('prompt 要求长概述（400-800 字）', SYSTEM_PROMPT.includes('400-800'));
  check('prompt 包含章节摘要与要点', SYSTEM_PROMPT.includes('sections') && SYSTEM_PROMPT.includes('summary') && SYSTEM_PROMPT.includes('bullets'));
  check('prompt 包含关键词/待确认/发言人总结', SYSTEM_PROMPT.includes('keywords') && SYSTEM_PROMPT.includes('openQuestions') && SYSTEM_PROMPT.includes('speakerSummaries'));
  check('prompt 要求决策依据与风险建议', SYSTEM_PROMPT.includes('rationale') && SYSTEM_PROMPT.includes('suggestion'));
  const withSpeakers = buildUserPrompt({ title: 'T', date: '2026-01-01', attendees: [], notes: '', transcript: 'S1：你好\nS2：收到' });
  const withoutSpeakers = buildUserPrompt({ title: 'T', date: '2026-01-01', attendees: [], notes: '', transcript: '大家好，今天开会' });
  const withSegments = buildUserPrompt({
    title: 'T', date: '2026-01-01', attendees: [], notes: '', transcript: 'A：你好\nB：收到',
    transcriptSegments: [{ speaker: 'A', text: '你好' }, { speaker: 'B', text: '收到' }, { speaker: 'A', text: '继续' }],
  });
  check('有说话人标记时提示按人总结', withSpeakers.includes('S1/S2') && withSpeakers.includes('speakerSummaries'));
  check('有说话人分段时把真实说话人交给模型', withSegments.includes('A、B') && withSegments.includes('speakerSummaries'));
  check('无说话人标记时要求输出空 speakerSummaries', withoutSpeakers.includes('空数组'));
}

/* 4. 导出文档要包含新结构 */
{
  const meeting = {
    title: '详细纪要测试', date: '2026-01-01', sourceType: 'recording', attendees: ['张三', '李四'],
    transcript: 'S1：大家好\nS2：收到', transcriptSeconds: 60,
    summary: normalizeSummary({
      oneLine: '结论句',
      overview: '第一段。\n\n第二段。',
      keyPoints: ['要点一', '要点二'],
      keywords: ['关键词甲', '关键词乙'],
      decisions: [{ text: '决定上线', owner: '张三', rationale: '依据客户档期' }],
      risks: [{ text: '迁移风险', level: 'high', suggestion: '灰度发布' }],
      sections: [{ heading: '预算评审', summary: '本节确认预算。', bullets: ['上限 200 万'] }],
      openQuestions: ['谁负责迁移？'],
      speakerSummaries: [{ speaker: 'S1', summary: '关注排期' }],
      attendees: ['张三', '李四'],
      todos: [{ title: '输出方案', owner: '李四', due: '2026-02-01', priority: 'high', notes: '' }],
    }),
  };
  const md = buildMarkdown(meeting);
  check('Markdown 含关键词', md.includes('## 关键词') && md.includes('关键词甲'));
  check('Markdown 含章节速览与章节摘要', md.includes('## 章节速览') && md.includes('本节确认预算。'));
  check('Markdown 含决策依据', md.includes('依据/影响：依据客户档期'));
  check('Markdown 含风险建议', md.includes('应对建议：灰度发布'));
  check('Markdown 含待确认问题与发言人总结', md.includes('## 待确认问题') && md.includes('## 发言人总结'));
  const html = buildHtml(meeting);
  check('HTML 含关键词与章节摘要', html.includes('class="keywords"') && html.includes('本节确认预算。'));
  check('HTML 含发言人总结与待确认问题', html.includes('class="speaker"') && html.includes('待确认问题'));
  const docx = buildDocx(meeting);
  const docxText = Buffer.from(docx).toString('utf8');
  check('Word 含章节速览与关键词', docxText.includes('章节速览') && docxText.includes('关键词'));
  check('Word 含发言人总结', docxText.includes('发言人总结'));
}

if (failures > 0) {
  console.log('RICH SUMMARY TESTS FAILED:', failures);
  process.exitCode = 1;
} else {
  console.log('ALL RICH SUMMARY TESTS PASSED');
}
