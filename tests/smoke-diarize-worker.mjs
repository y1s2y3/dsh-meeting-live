/**
 * 离线测试：声纹分离子进程（diarize-worker.js）的启动契约。
 *
 * 背景：分离很慢（1 小时音频 7–10 分钟），必须放到独立子进程跑，避免阻塞宿主事件循环；
 * 宿主通过 args.json 传参、读 output.json 拿结果，并用 STAGE 行更新进度。
 * 这里直接 spawn 一次 worker（模型路径故意给空）验证：进程能启动、失败时写回 ok:false。
 *
 * 用法：node tests/smoke-diarize-worker.mjs [插件目录]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const installedDir = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-meeting-live')
const pluginDir = process.argv[2] ?? (fs.existsSync(path.join(repoRoot, 'src', 'lib', 'diarize-worker.js')) ? path.join(repoRoot, 'src') : installedDir)
const workerPath = path.join(pluginDir, 'lib', 'diarize-worker.js')

let failures = 0
function check(label, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ← ' + detail}`)
  if (!condition) failures += 1
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-diarize-worker-'))
const audioPath = path.join(tmpDir, 'fake.wav')
fs.writeFileSync(audioPath, 'not-a-real-wav')

/**
 * 沙箱内不能通过管道捕获子进程输出（named pipe 限制），所以把 stdout/stderr 重定向到文件再读。
 */
function runWorker(args) {
  const argsPath = path.join(tmpDir, 'args-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.json')
  fs.writeFileSync(argsPath, JSON.stringify(args), 'utf8')
  const stdoutPath = argsPath + '.stdout.txt'
  const stderrPath = argsPath + '.stderr.txt'
  const outFd = fs.openSync(stdoutPath, 'w')
  const errFd = fs.openSync(stderrPath, 'w')
  return new Promise((resolve) => {
    let child = null
    try {
      child = spawn(process.execPath, [workerPath, argsPath], { stdio: ['ignore', outFd, errFd] })
    } catch (error) {
      fs.closeSync(outFd)
      fs.closeSync(errFd)
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error) })
      return
    }
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, 30_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      try { fs.closeSync(outFd) } catch { /* ignore */ }
      try { fs.closeSync(errFd) } catch { /* ignore */ }
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error) })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      try { fs.closeSync(outFd) } catch { /* ignore */ }
      try { fs.closeSync(errFd) } catch { /* ignore */ }
      resolve({
        code: code === null ? -1 : code,
        stdout: fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '',
        stderr: fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '',
      })
    })
  })
}

/* 1. 模型未就绪：进程要正常启动、写回 ok:false 与中文错误、退出码非 0 */
{
  const outputPath = path.join(tmpDir, 'out-model-missing.json')
  const result = await runWorker({ audioPath, models: {}, numClusters: 0, outputPath })
  const parsed = fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath, 'utf8')) : null
  check('worker 能启动并退出（模型缺失时非 0）', result.code !== 0, `exit=${result.code}`)
  check('worker 写回结果文件', parsed !== null, outputPath)
  check('失败结果带 ok:false 与中文原因', parsed?.ok === false && String(parsed?.error ?? '').includes('说话人分离模型未就绪'), JSON.stringify(parsed))
  check('stderr 里有 STAGE error 标记', result.stderr.includes('STAGE error'), result.stderr.slice(0, 160))
}

/* 2. 参数文件缺失：直接报错退出（不会卡住） */
{
  const stdoutPath = path.join(tmpDir, 'noargs.stdout.txt')
  const stderrPath = path.join(tmpDir, 'noargs.stderr.txt')
  const outFd = fs.openSync(stdoutPath, 'w')
  const errFd = fs.openSync(stderrPath, 'w')
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [workerPath], { stdio: ['ignore', outFd, errFd] })
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, 30_000)
    child.on('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode) })
    child.on('error', () => { clearTimeout(timer); resolve(-1) })
  })
  try { fs.closeSync(outFd) } catch { /* ignore */ }
  try { fs.closeSync(errFd) } catch { /* ignore */ }
  check('缺参数时立即失败（不会卡住）', code !== 0 && code !== null, `exit=${code}`)
}

/* 3. 参数契约：worker 也能接受 numClusters（指定人数）字段 */
{
  const outputPath = path.join(tmpDir, 'out-forced.json')
  const result = await runWorker({ audioPath, models: {}, numClusters: 4, outputPath })
  check('指定人数参数不导致参数解析错误', !result.stderr.includes('SyntaxError') && !result.stderr.includes('JSON'), result.stderr.slice(0, 160))
}

fs.rmSync(tmpDir, { recursive: true, force: true })

console.log('')
if (failures > 0) {
  console.error(`FAILED: ${failures} case(s)`)
  process.exit(1)
}
console.log('ALL DIARIZE WORKER CHECKS PASSED')
