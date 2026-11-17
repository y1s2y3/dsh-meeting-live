/**
 * 离线测试：「查看目录 / 播放」的进程启动参数与失败判定。
 *
 * 背景（2026-11-17 两次实测）：点「查看目录」没反应。对照 DSH 自带
 * `@deepseek-ai/dsh-native-command` 的实现后，要求：
 *   ① 目标用 file URL 编码，`/select,<编码后的路径>` 必须是同一个参数；
 *   ② 不用 `windowsHide: true`（GUI 进程带 SW_HIDE 会「进程起来但窗口不可见」）；
 *   ③ Explorer 把请求转交给已运行的桌面进程后自身退出码是 1，算成功；其他非零退出算失败；
 *   ④ 启动失败/文件不存在返回 false，界面据此提示。
 *
 * 用法：node tests/smoke-media-reveal.mjs [插件目录]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const installedDir = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-meeting-live')
const pluginDir = process.argv[2] ?? (fs.existsSync(path.join(repoRoot, 'src', 'lib', 'server.js')) ? path.join(repoRoot, 'src') : installedDir)
const { revealMediaPath, openMediaPath } = await import(pathToFileURL(path.join(pluginDir, 'lib', 'server.js')).href)

let failures = 0
function check(label, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ← ' + detail}`)
  if (!condition) failures += 1
}

/** 假 spawn：记录参数；注册 on('exit') 后异步回调，让 launchGui 的 Promise 结束。 */
function makeSpawn(exitCode = 0, options = {}) {
  const calls = []
  const spawn = (command, args, spawnOptions) => {
    if (options.throwOnSpawn === true) throw new Error('spawn blocked')
    calls.push({ command, args, options: spawnOptions })
    const child = {
      on(event, callback) {
        if (event === 'exit') setTimeout(() => callback(exitCode), 0)
        return child
      },
      unref() {},
    }
    return child
  }
  return { spawn, calls }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-reveal-'))
const plainFile = path.join(tmpDir, 'meeting 20261117-1725.wav')
fs.writeFileSync(plainFile, 'fake-wav')
const chineseFile = path.join(tmpDir, '会议录音-20261117.wav')
fs.writeFileSync(chineseFile, 'fake-wav')

/* 1. 查看目录：Windows 下单参数 /select,<编码后目标>，不隐藏窗口，退出码 1 算成功 */
{
  const { spawn, calls } = makeSpawn(1)
  const ok = await revealMediaPath(chineseFile, spawn)
  const call = calls[0]
  check('文件存在时返回成功（Explorer 退出码 1 = 已转交）', ok === true)
  check('调用 explorer.exe', call?.command === 'explorer.exe', String(call?.command))
  if (process.platform === 'win32') {
    check('/select, 与目标连成一个参数', call?.args?.length === 1 && String(call.args[0]).startsWith('/select,file:///'), JSON.stringify(call?.args))
    check('中文路径不被百分号编码（Explorer 认字面中文）', String(call?.args?.[0]).includes('会议录音'), String(call?.args?.[0]))
    check('不隐藏窗口（windowsHide 必须为 false）', call?.options?.windowsHide === false, JSON.stringify(call?.options))
    check('不再使用 detached', call?.options?.detached !== true)
  }
}

/* 2. Explorer 退出码 2：判定失败，界面能提示 */
{
  const { spawn } = makeSpawn(2)
  const ok = await revealMediaPath(plainFile, spawn)
  check('Explorer 异常退出码判失败', ok === false)
}

/* 3. 路径里的逗号/等号要转义（Explorer 会按分隔符截断） */
{
  const { spawn, calls } = makeSpawn(1)
  const tricky = path.join(tmpDir, 'a,b=c.wav')
  fs.writeFileSync(tricky, 'x')
  await revealMediaPath(tricky, spawn)
  const arg = String(calls[0]?.args?.[0] ?? '')
  check('逗号与等号被转义', arg.includes('%2C') && arg.includes('%3D'), arg)
}

/* 4. 文件不存在 / 空路径 / spawn 抛错：都安全返回 false */
{
  const a = makeSpawn(0)
  const missing = await revealMediaPath(path.join(tmpDir, '不存在.wav'), a.spawn)
  const empty = await revealMediaPath('', a.spawn)
  const b = makeSpawn(0, { throwOnSpawn: true })
  const blocked = await revealMediaPath(plainFile, b.spawn)
  check('文件不存在返回 false', missing === false)
  check('空路径返回 false', empty === false)
  check('spawn 抛错时安全降级', blocked === false)
  check('无效路径不启动 explorer', a.calls.length === 0, `spawn 次数=${a.calls.length}`)
}

/* 5. 播放：Windows 上交给 Explorer 打开（不闪控制台、支持中文），退出码 0 算成功 */
{
  const { spawn, calls } = makeSpawn(0)
  const ok = await openMediaPath(plainFile, spawn)
  const call = calls[0]
  check('播放调用成功', ok === true)
  if (process.platform === 'win32') {
    check('播放也走 explorer.exe', call?.command === 'explorer.exe', String(call?.command))
    check('播放目标是编码后的文件 URI（单个参数）', call?.args?.length === 1 && String(call.args[0]).startsWith('file:///'), JSON.stringify(call?.args))
    check('播放不隐藏窗口', call?.options?.windowsHide === false)
  }
}

/* 6. 播放失败与不存在文件 */
{
  const bad = makeSpawn(3)
  const failed = await openMediaPath(plainFile, bad.spawn)
  const none = makeSpawn(0)
  const missing = await openMediaPath(path.join(tmpDir, 'missing.wav'), none.spawn)
  check('播放异常退出码判失败', failed === false)
  check('播放不存在文件返回 false', missing === false)
  check('播放不存在文件不启动进程', none.calls.length === 0)
}

/* 7. 测试模式开关仍然生效 */
{
  const { spawn, calls } = makeSpawn(0)
  process.env.DSH_MEETING_NO_OPEN = '1'
  const ok = await openMediaPath(plainFile, spawn)
  delete process.env.DSH_MEETING_NO_OPEN
  check('DSH_MEETING_NO_OPEN=1 时不启动进程', ok === true && calls.length === 0)
}

fs.rmSync(tmpDir, { recursive: true, force: true })

console.log('')
if (failures > 0) {
  console.error(`FAILED: ${failures} case(s)`)
  process.exit(1)
}
console.log('ALL MEDIA REVEAL CHECKS PASSED')
