/**
 * 离线测试：「停止长会议不再卡」的关键约束（源码级，防止回退）。
 *
 * 背景（2026-11-18 实测）：57 分钟会议停止后，宿主在音频上传回调里**同步**调用
 * `transcribeFileWithSpeakers` 做整段分离，阻塞事件循环 11 分钟（10:59:47 → 11:10:58），
 * 期间页面与其它插件全卡死；同时 ffmpeg 合成录屏 MP4 也在响应前等待（55 秒）。
 *
 * 约束：
 *   1) 上传接口必须先返回，再在后台做「合成 / 质量分析 / 声纹分离 / 纠错」；
 *   2) 声纹分离只能通过 startDiarizeJob（独立子进程 + 缓存）启动，不能同步调用；
 *   3) 前端自动分离轮询要看任务状态并显示已运行时长，不能 2 分钟就报超时。
 *
 * 用法：node tests/smoke-stop-fast.mjs [插件目录]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const installedDir = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-meeting-live')
const pluginDir = process.argv[2] ?? (fs.existsSync(path.join(repoRoot, 'src', 'lib', 'server.js')) ? path.join(repoRoot, 'src') : installedDir)
const serverSrc = fs.readFileSync(path.join(pluginDir, 'lib', 'server.js'), 'utf8')
const clientSrc = fs.readFileSync(path.join(pluginDir, 'lib', 'client.js'), 'utf8')

let failures = 0
function check(label, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ← ' + detail}`)
  if (!condition) failures += 1
}

/* 1. 上传回调里不能再同步做整段声纹分离 */
{
  const calls = serverSrc.split('\n').filter((line) => line.includes('transcribeFileWithSpeakers') && !line.trim().startsWith('//') && !line.trim().startsWith('*'))
  check('上传/后台流程不再同步调用 transcribeFileWithSpeakers', calls.length === 0, calls.join(' / ').slice(0, 160))
  check('存在统一入口 startDiarizeJob', /function startDiarizeJob\(/.test(serverSrc))
  check('上传后自动分离走 startDiarizeJob（reason: auto）', /startDiarizeJob\(\{[^}]*reason: 'auto'/s.test(serverSrc))
}

/* 2. 上传接口先返回，重活放后台 */
{
  const sendIdx = serverSrc.indexOf('postProcessing: true')
  const muxIdx = serverSrc.indexOf('muxScreenWithAudio({ videoPath: pendingMux.pendingVideo.tmpPath')
  const qualityIdx = serverSrc.indexOf('const analyzed = analyzeWavQuality(bytes)')
  check('上传接口带「立即返回、后台处理」标记', sendIdx > 0)
  check('MP4 合成在响应之后（不阻塞停止）', sendIdx > 0 && muxIdx > sendIdx, `send=${sendIdx} mux=${muxIdx}`)
  check('录音质量分析在响应之后', sendIdx > 0 && qualityIdx > sendIdx, `send=${sendIdx} quality=${qualityIdx}`)
  check('先用「转换中」占位视频条目（界面可轮询）', /converting: true/.test(serverSrc) && /placeholderVideo/.test(serverSrc))
}

/* 3. 前端自动分离：轮询任务状态、显示已运行时长、不再 2 分钟超时 */
{
  check('自动分离轮询任务状态（status === running/done）', clientSrc.includes("status === 'running'") && clientSrc.includes("status === 'done'"))
  check('自动分离读取 elapsedSeconds 显示已运行时长', /elapsedSeconds: Number\(job\.elapsedSeconds\)/.test(clientSrc))
  check('不再用「24 次即超时」的旧逻辑', !clientSrc.includes('tries >= 24'))
  check('自动分离读取逐句进度（transcribeDone/Total）', clientSrc.includes('transcribeDone') && clientSrc.includes('transcribeTotal'))
}

/* 4. 关键文案/接口仍在（避免误删） */
{
  check('保留手动「重新分离说话人」路由', serverSrc.includes("segments[2] === 'diarize'"))
  check('保留取消路由', serverSrc.includes("segments[3] === 'cancel'"))
  check('保留缓存读写', serverSrc.includes('readDiarizeCache') && serverSrc.includes('writeDiarizeCache'))
}

console.log('')
if (failures > 0) {
  console.error(`FAILED: ${failures} case(s)`)
  process.exit(1)
}
console.log('ALL STOP-FAST CHECKS PASSED')
