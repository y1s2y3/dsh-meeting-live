/**
 * 生成一份**完全虚构、脱敏**的示例会议纪要（.docx），用于 docs/ 里的导出样式预览。
 * 不要用真实会议内容生成示例文件（历史踩坑：docs 里曾放过真实会议导出件，存在泄露风险）。
 *
 * 用法：node docs/gen-sample-docx.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const { buildDocx } = await import(pathToFileURL(path.join(ROOT, 'src', 'lib', 'export.js')).href);

/** 纯虚构数据：项目/人名/内容都不可对应到真实会议 */
const meeting = {
  id: 'mt_sample_demo',
  title: '示例会议：移动端改版排期评审（脱敏样例）',
  date: '2026-01-15',
  sourceType: 'recording',
  attendees: ['张一', '李二', '王三'],
  transcriptSeconds: 1620,
  transcript: [
    '张一：今天主要过一下移动端改版的排期，先确认范围。',
    '李二：首期做登录、首页和消息中心三块，其余放到第二期。',
    '王三：设计稿周三能给到，开发需要预留两天联调。',
    '张一：那就按「设计周三、开发下周一启动」这个节奏推进，风险点列一下。',
    '李二：历史数据的迁移方案还没定，需要再确认。',
  ].join('\n'),
  summary: {
    oneLine: '移动端改版首期范围确定（登录/首页/消息中心），按设计周三交付、开发下周一启动推进。',
    overview: '本次会议围绕移动端改版的范围、排期与风险展开，确认首期只做登录、首页与消息中心三个模块，其余功能进入第二期；设计稿周三交付，开发下周一启动，联调预留两天。历史数据迁移方案尚未确定，需要会后单独确认。',
    keyPoints: [
      '首期范围：登录、首页、消息中心三个模块',
      '第二期再排其余功能，避免首期范围膨胀',
      '设计稿周三交付，开发下周一启动，联调预留两天',
      '历史数据迁移方案待确认，是当前主要风险',
    ],
    decisions: [
      { text: '首期只做登录、首页、消息中心三个模块', owner: '张一' },
      { text: '按「设计周三、开发下周一启动」的节奏推进', owner: '李二' },
    ],
    risks: [
      { text: '历史数据迁移方案尚未确定，可能影响上线时间', level: 'high' },
      { text: '联调时间只有两天，接口联调有延期风险', level: 'medium' },
    ],
    sections: [
      {
        heading: '范围与排期',
        bullets: [
          '首期包含登录、首页、消息中心三个模块',
          '设计稿周三交付，开发下周一启动',
          '联调预留两天，上线时间待定',
        ],
      },
      {
        heading: '风险与待确认',
        bullets: [
          '历史数据迁移方案需要单独评审',
          '第二期功能清单尚未拆分',
        ],
      },
    ],
    attendees: ['张一', '李二', '王三'],
    suggestedTitle: '移动端改版排期评审（示例）',
    todos: [
      { id: 'td_demo_1', title: '输出移动端首期功能清单', owner: '张一', due: '2026-01-18', priority: 'high', notes: '含登录/首页/消息中心', status: 'pending', calendarTaskId: null },
      { id: 'td_demo_2', title: '提交设计稿', owner: '王三', due: '2026-01-21', priority: 'normal', notes: '', status: 'pending', calendarTaskId: null },
      { id: 'td_demo_3', title: '确认历史数据迁移方案', owner: '李二', due: '', priority: 'high', notes: '需要单独评审', status: 'pending', calendarTaskId: null },
    ],
  },
  notes: '（本文件为自动生成的脱敏示例，不含任何真实会议内容）',
  createdAt: Date.parse('2026-01-15T10:00:00+08:00'),
  updatedAt: Date.parse('2026-01-15T11:00:00+08:00'),
};

const out = path.join(HERE, '会议纪要-导出样式示例.docx');
fs.writeFileSync(out, buildDocx(meeting));
console.log('已生成脱敏示例：', out, fs.statSync(out).size, 'bytes');
