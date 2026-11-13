#!/usr/bin/env node
/**
 * 把 src/ 里的插件源码部署到 DSH Desktop 的 profile（node_modules 安装目录）。
 *
 * 用法：
 *   node deploy.mjs                     # 部署到默认 profile（desktop）
 *   node deploy.mjs --profile desktop   # 指定 profile 名
 *   node deploy.mjs --dir <profile目录> # 直接指定 profile 目录
 *   node deploy.mjs --dry-run           # 只看会做什么，不写文件
 *   node deploy.mjs --no-backup         # 不备份线上版本（不推荐）
 *
 * 说明：
 * - 部署前会把目标目录整体备份到 backups/<时间戳>/（可用 --no-backup 关闭）。
 * - 宿主半（lib/*.js、package.json、cordis.patch.yml、resources）改动后需要**重启 DSH Desktop**。
 * - 浏览器半（lib/client.js）改动后**刷新页面**即可。
 * - 目标目录被 Desktop 占用时，写不进去会明确报错——先退出 Desktop 再部署。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'src');
const PKG_NAME = 'dsh-plugin-meeting-minutes';

function parseArgs(argv) {
  const options = { profile: 'desktop', dir: null, dryRun: false, backup: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--no-backup') options.backup = false;
    else if (arg === '--profile') { options.profile = argv[index + 1]; index += 1; }
    else if (arg === '--dir') { options.dir = argv[index + 1]; index += 1; }
    else if (arg === '--help' || arg === '-h') { console.log('用法见文件头部注释'); process.exit(0); }
  }
  return options;
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** 复制目录（保留文件字节内容，不做任何转换）。 */
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

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(SRC, 'package.json'))) {
    console.error(`[错误] 找不到源码：${SRC}\\package.json`);
    process.exit(1);
  }
  const profileDir = options.dir !== null
    ? path.resolve(options.dir)
    : path.join(os.homedir(), '.dsh', 'profiles', options.profile);
  const modulesDir = path.join(profileDir, 'node_modules');
  const target = path.join(modulesDir, PKG_NAME);

  console.log(`源目录   : ${SRC}`);
  console.log(`目标目录 : ${target}`);
  if (!fs.existsSync(profileDir)) {
    console.error('[错误] profile 目录不存在，请确认 DSH Desktop 已安装并登录过。');
    process.exit(1);
  }

  if (options.dryRun) {
    console.log('[dry-run] 不写任何文件。');
    return;
  }

  fs.mkdirSync(modulesDir, { recursive: true });

  if (options.backup && fs.existsSync(target)) {
    const backupDir = path.join(HERE, 'backups', timestamp());
    fs.mkdirSync(backupDir, { recursive: true });
    copyTree(target, path.join(backupDir, PKG_NAME));
    console.log(`已备份线上版本 → backups/${path.basename(backupDir)}/`);
  }

  try {
    const count = copyTree(SRC, target);
    console.log(`[完成] 已复制 ${count} 个文件到安装目录。`);
  } catch (error) {
    console.error(`[失败] 写安装目录失败：${String(error?.message ?? error)}`);
    console.error('常见原因：DSH Desktop 正在运行且占用了插件文件。请先完全退出 Desktop，再执行部署。');
    process.exit(1);
  }

  console.log('');
  console.log('接下来：');
  console.log('  1) 改了 lib/client.js 等浏览器半 → 刷新页面（Ctrl+R）即可；');
  console.log('  2) 改了 lib/server.js、lib/index.js、package.json、cordis.patch.yml、resources/*.ps1');
  console.log('     → 需要重启 DSH Desktop 才会加载。');
}

main();
