#!/usr/bin/env node
/**
 * 把 src/ 打包成可以直接安装/发给别人的插件包（tar.gz）。
 *
 * 用法：
 *   node package.mjs                                    # 用 src/package.json 的名字和版本
 *   node package.mjs --name dsh-meeting-live-pro --version 1.2.0
 *   node package.mjs --out D:\dist                      # 指定输出目录（默认 ./dist）
 *
 * 产物：dist/<包名>-<版本>.tgz（内含 <包名>/ 目录，可直接被 npm/pnpm 安装）
 * 同时会在 dist/ 写一份《安装说明-<版本>.md》。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'src');

function parseArgs(argv) {
  const options = { name: null, version: null, out: path.join(HERE, 'dist') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--name') { options.name = argv[index + 1]; index += 1; }
    else if (arg === '--version') { options.version = argv[index + 1]; index += 1; }
    else if (arg === '--out') { options.out = path.resolve(argv[index + 1]); index += 1; }
    else if (arg === '--help' || arg === '-h') { console.log('用法见文件头部注释'); process.exit(0); }
  }
  return options;
}

function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) count += copyTree(from, to);
    else {
      fs.copyFileSync(from, to);
      count += 1;
    }
  }
  return count;
}

function readmeFor(name, version) {
  return `# ${name} v${version}

> 自研版本 · 维护者：DinosaurYSL · 许可：MIT（授权文本见包内 \`LICENSE\`）

## 这是什么

DSH Desktop（DeepSeek Harness）的「会议纪要」插件：录音/录屏 → 实时转写 → AI 结构化纪要 → 待办 → 导出。

## 环境前提

| 前提 | 是否必须 | 说明 |
|---|---|---|
| Windows 10/11 | 必须 | 桌面浮窗用 PowerShell + WPF 实现 |
| DSH Desktop ≥ 2.0.17 | 必须 | 插件加载器版本要求 |
| ffmpeg | 录像/自动转写相关功能需要 | 缺 ffmpeg 时：录屏不可用（只录音频）、腾讯会议 mp4/m4a 与监控目录非 WAV 音视频无法自动转写；实时录音转写与文本纪要不受影响。自动探测 PATH / winget 目录，也可设 \`FFMPEG_PATH\` |
| dsh-memory-evolve 插件 | 可选 | 「写入待办」需要它；没装则该按钮置灰，其他功能正常 |

安装 ffmpeg（Windows，任一方式）：
- \`winget install Gyan.FFmpeg\`（推荐）
- 或把 ffmpeg.exe 放到 PATH 里，或设置环境变量 \`FFMPEG_PATH\`

## 安装方式 A：桌面端插件页（推荐）

1. 打开 DSH Desktop → 插件 → 从本地文件安装，选择本 tgz；
2. 或者把 tgz 解压出来的 \`${name}\` 目录放进
   \`%USERPROFILE%\\.dsh\\profiles\\desktop\\node_modules\\\`；
3. 打开 \`%USERPROFILE%\\.dsh\\profiles\\desktop\\package.json\`，把 \`${name}\` 加进
   \`dependencies\` 与 \`dsh.profile.bundles\`；
4. 完全重启 DSH Desktop。

## 安装方式 B：命令行

\`\`\`powershell
dsh plugin --profile desktop add "<本 tgz 的绝对路径>"
\`\`\`

（如果提示 profile 由桌面端独占管理，用方式 A 的手工步骤。）

## 首次使用

1. 左侧「实时录音/录屏」开始录音；需要录屏就勾选「同步录屏」，浏览器会让你选屏幕；
2. 停止后自动生成 MP4 视频（带配音）+ WAV 音频，存在
   \`%USERPROFILE%\\.dsh\\storages\\meeting-minutes-media\\<会议ID>\\\`；
3. 生成 AI 纪要后，详情页会出现「AI 会议纪要」卡片（可复制、可展开）；
4. 待办可一键写入 DSH 待办（工作类型）。

## 卸载

删掉 profile 的 \`node_modules\\${name}\` 目录、并从 \`package.json\` 的
\`dependencies\` / \`dsh.profile.bundles\` 里删掉 \`${name}\`，然后重启 Desktop。
`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(SRC, 'package.json'))) {
    console.error(`[错误] 找不到源码：${SRC}\\package.json`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
  const name = options.name ?? manifest.name;
  const version = options.version ?? manifest.version;
  const outDir = options.out;
  fs.mkdirSync(outDir, { recursive: true });

  // 1. 暂存：复制源码 + 改写 package.json（包名/版本可覆写）
  const stageRoot = path.join(outDir, 'stage');
  fs.rmSync(stageRoot, { recursive: true, force: true });
  const staged = path.join(stageRoot, name);
  const count = copyTree(SRC, staged);
  const stagedManifest = { ...manifest, name, version };
  fs.writeFileSync(path.join(staged, 'package.json'), `${JSON.stringify(stagedManifest, null, 2)}\n`, 'utf8');

  // 2. 打 tgz（Windows 自带 tar.exe）
  const tarball = path.join(outDir, `${name}-${version}.tgz`);
  if (fs.existsSync(tarball)) fs.rmSync(tarball);
  execFileSync('tar', ['-czf', tarball, '-C', stageRoot, name], { stdio: 'inherit' });
  const tarballInfo = fs.statSync(tarball);

  // 3. 安装说明
  const readmeFile = path.join(outDir, `安装说明-${version}.md`);
  fs.writeFileSync(readmeFile, readmeFor(name, version), 'utf8');

  console.log('');
  console.log('[完成] 打包产物');
  console.log(`  包文件 : ${tarball}  (${(tarballInfo.size / 1024).toFixed(0)} KB)`);
  console.log(`  文件数 : ${count}`);
  console.log(`  说明   : ${readmeFile}`);
  console.log('');
  console.log('别人安装：把 tgz 解压到 node_modules 下并登记到 profile（详见安装说明）。');
}

main();
