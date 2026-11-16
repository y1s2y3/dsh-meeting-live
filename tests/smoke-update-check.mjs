import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* 更新检查回归测试：只查版本号、不下载不安装。
   覆盖：版本比较、npm 优先、GitHub 兜底、双源失败、缓存与 force。 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleFile = path.join(root, 'src', 'lib', 'update-check.js');
const {
  CURRENT_VERSION,
  compareVersions,
  checkForUpdate,
  resetUpdateCache,
} = await import(pathToFileURL(moduleFile).href);

let failures = 0;
function check(name, passed, detail) {
  if (passed) {
    console.log('[OK] ' + name);
  } else {
    failures += 1;
    console.log('[FAIL] ' + name + (detail === undefined ? '' : ' → ' + JSON.stringify(detail)));
  }
}

/* 1. 版本号比较 */
check('compareVersions 1.2.0 > 1.1.9', compareVersions('1.2.0', '1.1.9') === 1);
check('compareVersions v1.1.0 = 1.1.0', compareVersions('v1.1.0', '1.1.0') === 0);
check('compareVersions 1.10.0 > 1.9.9（按数字而非字典序）', compareVersions('1.10.0', '1.9.9') === 1);
check('compareVersions 1.1.0-beta.1 与 1.1.0 视为相等（忽略预发布后缀）', compareVersions('1.1.0-beta.1', '1.1.0') === 0);
check('compareVersions 1.0 < 1.0.1', compareVersions('1.0', '1.0.1') === -1);

/* 2. npm 有更新时优先用 npm */
{
  resetUpdateCache();
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    if (String(url).includes('registry.npmjs.org')) {
      return { ok: true, json: async () => ({ version: '9.9.9' }) };
    }
    return { ok: false, json: async () => ({}) };
  };
  const result = await checkForUpdate({ fetcher, force: true });
  check('npm 返回新版本时 hasUpdate=true', result.ok === true && result.hasUpdate === true && result.latest === '9.9.9', result);
  check('来源标记为 npm', result.source === 'npm', result.source);
  const urlOk = /releases\/latest$/.test(result.url ?? '') || /^https:\/\/www\.npmjs\.com\/package\//.test(result.url ?? '')
  check('返回可用的下载页地址（Releases 或 npm 页面）', urlOk, result.url);
  check('只会查 npm，不再查 GitHub', calls.length === 1 && calls[0].includes('registry.npmjs.org'), calls);
}

/* 3. npm 404 时回退 GitHub Releases */
{
  resetUpdateCache();
  const fetcher = async (url) => {
    if (String(url).includes('registry.npmjs.org')) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ tag_name: 'v' + CURRENT_VERSION }) };
  };
  const result = await checkForUpdate({ fetcher, force: true });
  check('npm 无包时回退 GitHub', result.ok === true && result.source === 'github', result);
  check('GitHub 兜底时下载地址是 Releases 页', /^https:\/\/github\.com\/.+\/releases\/latest$/.test(result.url ?? ''), result.url);
  check('GitHub 版本与当前相同 → 没有更新', result.hasUpdate === false && result.latest === CURRENT_VERSION, result);
}

/* 4. 两个源都失败时给出可读错误（不抛异常） */
{
  resetUpdateCache();
  const fetcher = async () => ({ ok: false, json: async () => ({}) });
  const result = await checkForUpdate({ fetcher, force: true });
  check('双源失败时 ok=false 且有中文提示', result.ok === false && typeof result.error === 'string' && result.error.length > 0, result);
  check('双源失败时 hasUpdate=false（界面不会误报有新版）', result.hasUpdate === false, result.hasUpdate);
}

/* 5. 缓存：10 分钟内不重复请求；force 跳过缓存 */
{
  resetUpdateCache();
  let calls = 0;
  const fetcher = async (url) => {
    calls += 1;
    if (String(url).includes('registry.npmjs.org')) return { ok: true, json: async () => ({ version: '2.0.0' }) };
    return { ok: false, json: async () => ({}) };
  };
  const first = await checkForUpdate({ fetcher });
  const second = await checkForUpdate({ fetcher });
  check('缓存生效：连续两次检查只请求一次', calls === 1 && first.latest === second.latest, { calls });
  await checkForUpdate({ fetcher, force: true });
  check('force=true 会绕过缓存重新请求', calls === 2, { calls });
}

if (failures > 0) {
  console.log('UPDATE CHECK TESTS FAILED:', failures);
  process.exitCode = 1;
} else {
  console.log('ALL UPDATE CHECK TESTS PASSED');
}
