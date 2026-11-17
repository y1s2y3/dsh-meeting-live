/**
 * 离线测试：「查看目录 / 播放」的进程启动参数。
 *
 * 背景（2026-11-17 实测）：点「查看目录」没反应。旧实现是
 *   spawn('explorer.exe', ['/select,', target], { detached: true, ... })
 * 两个坑：① /select, 必须与路径连成一个参数；② Windows 上 detached + unref 会「起来但不执行」。
 * 这里用可注入的 spawn 桩验证参数与降级行为（不真的打开资源管理器）。
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

function makeSpawn() {
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    return { on() {}, unref() {} }
  }
  return { spawn, calls }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-reveal-'))
const mediaFile = path.join(tmpDir, '会议录音 20261117-1725.wav')
fs.writeFileSync(mediaFile, 'fake-wav')

/* 1. 文件存在：Windows 上必须是单个 /select,<路径> 参数，且不带 detached */
{
  const { spawn, calls } = makeSpawn()
  const ok = revealMediaPath(mediaFile, spawn)
  const call = calls[0]
  check('文件存在时返回成功', ok === true)
  check('调用 explorer.exe', call?.command === 'explorer.exe', String(call?.command))
  if (process.platform === 'win32') {
    check('/select, 与路径是同一个参数', call?.args?.length === 1 && call.args[0] === '/select,' + mediaFile, JSON.stringify(call?.args))
    check('不再使用 detached（Windows 上会起来但不执行）', call?.options?.detached !== true, JSON.stringify(call?.options))
  }
}

/* 2. 文件不存在 / 空路径：直接返回 false，不发请求给 explorer */
{
  const { spawn, calls } = makeSpawn()
  const missing = revealMediaPath(path.join(tmpDir, '不存在.wav'), spawn)
  const empty = revealMediaPath('', spawn)
  check('文件不存在时返回 false', missing === false)
  check('空路径返回 false', empty === false)
  check('无效路径不启动 explorer', calls.length === 0, `spawn 次数=${calls.length}`)
}

/* 3. spawn 自身抛错（例如策略拦截）时不崩、返回 false */
{
  const spawn = () => { throw new Error('spawn blocked') }
  const ok = revealMediaPath(mediaFile, spawn)
  check('spawn 抛错时安全降级', ok === false)
}

/* 4. 播放：Windows 走 cmd /c start "" <path>（首参为空标题位） */
{
  const { spawn, calls } = makeSpawn()
  const ok = openMediaPath(mediaFile, spawn)
  const call = calls[0]
  check('播放调用成功', ok === true)
  if (process.platform === 'win32') {
    check('调用 cmd.exe /c start', call?.command === 'cmd.exe' && call?.args?.[0] === '/c' && call?.args?.[1] === 'start', JSON.stringify(call?.args))
    check('start 的空标题位保留', call?.args?.[2] === '' && call?.args?.[3] === mediaFile, JSON.stringify(call?.args))
    check('播放也不使用 detached', call?.options?.detached !== true)
  }
}

/* 5. 播放不存在的文件：返回 false 且不启动进程 */
{
  const { spawn, calls } = makeSpawn()
  const ok = openMediaPath(path.join(tmpDir, 'missing.wav'), spawn)
  check('播放不存在文件返回 false', ok === false)
  check('播放不存在文件不启动进程', calls.length === 0)
}

fs.rmSync(tmpDir, { recursive: true, force: true })

console.log('')
if (failures > 0) {
  console.error(`FAILED: ${failures} case(s)`)
  process.exit(1)
}
console.log('ALL MEDIA REVEAL CHECKS PASSED')
