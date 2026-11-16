/**
 * 会议纪要插件 · 本地语音识别模型下载管理（自包含 ESM 模块）
 *
 * 职责：
 *   ① 从 hf-mirror 下载 ONNX 模型（先写 .part，成功后 rename 为正式名）；
 *   ② 下载过程按 1MB / 1 秒节流回调进度，并同步更新 status().downloading 供 UI 轮询；
 *   ③ 校验文件存在、非空、大小在允许误差内（ASSETS 里 bytes>0 的文件）；
 *   ④ 支持删除、查询路径、查询就绪状态。
 *
 * 设计约束：
 *   - 仅使用 Node 内置模块（node:fs / node:fs/promises / node:path / node:os）；
 *   - 顶层无副作用，不读写文件系统，全部动作都在 createModelManager() 返回的对象里；
 *   - 对外错误一律返回中文 { ok:false, error }，不把 URL、堆栈、底层 errno 抛给调用方；
 *   - 大文件（> 8MB）在镜像支持 Range 时用 4 段并发下载（按偏移直接写入 .part），
 *     不支持分段时自动退回单连接流式下载；不做断点续传，失败即清理 .part。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

/** 无数据可读（卡死）多久后放弃本次请求 */
const IDLE_TIMEOUT_MS = 60000
/** HEAD 探测超时 */
const HEAD_TIMEOUT_MS = 20000
/** 分段并发数 */
const CHUNK_CONCURRENCY = 4
/** 小于该大小不做分段（分段开销不值得） */
const MIN_PARALLEL_BYTES = 8 * 1024 * 1024
/** 单段最小字节数 */
const MIN_CHUNK_BYTES = 2 * 1024 * 1024
/** 进度回调的最小字节间隔（1MB） */
const PROGRESS_BYTES_STEP = 1024 * 1024
/** 进度回调的最小时间间隔（1 秒） */
const PROGRESS_TIME_STEP = 1000

/** 模型清单（URL 为已确认可用的 hf-mirror 地址；bytes 为 0 表示不校验大小）
 *  sha256 取自模型仓库的官方文件哈希（LFS 元数据；tokens.txt 非 LFS，按官方镜像文件固定），
 *  下载完成后逐个校验，防止镜像文件被替换。
 */
const ASSETS = {
  paraformer: {
    title: 'Paraformer 中文语音识别模型',
    files: [
      { name: 'model.int8.onnx', url: 'https://hf-mirror.com/csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09/resolve/main/model.int8.onnx', bytes: 227330205, sha256: '90bc03034ae1bef9575f8cc798cd1519c8be8aa9e8b458a033e32017ff4d584c' },
      { name: 'tokens.txt', url: 'https://hf-mirror.com/csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09/resolve/main/tokens.txt', bytes: 75354, sha256: '6c0e3b35cece259829e6cb5b8d90d13db88f61ea3a2953d11898e4b2bfd7a2e2' }
    ]
  },
  segmentation: {
    title: '说话人分段模型（pyannote）',
    files: [
      { name: 'model.int8.onnx', url: 'https://hf-mirror.com/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.int8.onnx', bytes: 1540506, sha256: 'd582f4b4c6b48205de7e0643c57df0df5615a3c176189be3fc461e9d18827b5d' }
    ]
  },
  campplus: {
    title: '说话人声纹模型（cam++）',
    files: [
      { name: '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx', url: 'https://hf-mirror.com/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx', bytes: 28281138, sha256: 'f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11' }
    ]
  }
}

/** 允许下载的模型类型（固定顺序，供 UI 稳定遍历） */
const KINDS = ['paraformer', 'segmentation', 'campplus']

/** 递归冻结，防止调用方误改清单 */
function deepFreeze(target) {
  for (const value of Object.values(target)) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) deepFreeze(value)
  }
  return Object.freeze(target)
}

deepFreeze(ASSETS)

/** 期望大小的容差：2%，但不小于 1KB（避免小文件被容差卡死） */
function toleranceOf(expectedBytes) {
  return Math.max(1024, Math.round(expectedBytes * 0.02))
}

/** 文件在本地清单里的逻辑名：onnx → model，其余用去掉扩展名的文件名（tokens.txt → tokens） */
function fileKeyOf(fileName) {
  if (typeof fileName !== 'string' || !fileName) return 'file'
  if (fileName.toLowerCase().endsWith('.onnx')) return 'model'
  return path.basename(fileName, path.extname(fileName))
}

/** 深拷贝模型清单（给 UI 展示标题 / 文件 / 大小，调用方改动不会污染模块常量） */
export function describeAssets() {
  if (typeof structuredClone === 'function') return structuredClone(ASSETS)
  return JSON.parse(JSON.stringify(ASSETS))
}

/**
 * 把底层异常翻译成面向用户的中文错误（不带 URL / 堆栈 / errno）
 */
function friendlyError(error) {
  if (error instanceof Error && error.message) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return '下载超时，请检查网络后重试'
    if (error.message.startsWith('下载失败')) return error.message
    if (error.message.startsWith('文件大小校验失败')) return error.message
    if (error.message.startsWith('模型文件校验失败')) return error.message
    if (error.message === '下载的文件为空') return error.message
    if (error.message === '下载的文件不完整') return error.message
    return '下载中断，请重试'
  }
  return '下载失败，请稍后重试'
}

/**
 * 创建「无数据即超时」的控制器：每收到一块数据就 touch() 重置计时
 */
function createIdleController(idleMs) {
  const controller = new AbortController()
  let timer = null
  const touch = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => controller.abort(), idleMs)
    if (typeof timer.unref === 'function') timer.unref()
  }
  const stop = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  touch()
  return {
    signal: controller.signal,
    touch,
    stop,
    abort: () => {
      stop()
      controller.abort()
    }
  }
}

/** 把若干分段拼接成请求信号（环境不支持 AbortSignal.any 时退化为空闲信号） */
function combineSignals(primary, secondary) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
      return AbortSignal.any([primary, secondary])
    }
  } catch {
    /* 忽略，走退化分支 */
  }
  return secondary
}

/** 按总大小切分下载区间（返回 null 表示不适合分段） */
function planChunks(totalBytes) {
  if (!(totalBytes >= MIN_PARALLEL_BYTES) || CHUNK_CONCURRENCY < 2) return null
  const count = Math.max(2, Math.min(CHUNK_CONCURRENCY, Math.ceil(totalBytes / MIN_CHUNK_BYTES)))
  const chunkSize = Math.ceil(totalBytes / count)
  const plan = []
  for (let index = 0; index < count; index += 1) {
    const start = index * chunkSize
    if (start >= totalBytes) break
    const end = Math.min(totalBytes, start + chunkSize) - 1
    plan.push({ index, start, end, length: end - start + 1 })
  }
  return plan.length > 1 ? plan : null
}

/**
 * 计算文件的 SHA-256（流式读取，避免把几百 MB 的模型一次读进内存）。
 * @param {string} filePath 文件绝对路径
 * @returns {Promise<string>} 小写十六进制摘要
 */
export async function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  const handle = await fsp.open(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead <= 0) break
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

/**
 * 创建模型管理器
 * @param {object} [options]
 * @param {string} [options.home]       DSH 主目录（默认 process.env.DSH_HOME 或 ~/.dsh）
 * @param {object} [options.logger]     可选日志器，需提供 info / warn 方法
 * @param {Function} [options.fetchImpl] 可选 fetch 实现，便于测试注入
 */
export function createModelManager(options = {}) {
  const config = options || {}
  const homeDir = config.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const rootDir = path.join(homeDir, 'meeting-minutes-models')
  const logger = config.logger
  const doFetch = typeof config.fetchImpl === 'function'
    ? config.fetchImpl
    : (url, init) => fetch(url, init)

  /** 下载中用 content-length 校准过期望大小的文件：`kind/fileName` → 实际字节数 */
  const calibrated = new Map()
  /** 当前下载任务进度快照（同一时刻只允许一个下载任务） */
  let downloading = null

  function isKind(kind) {
    return KINDS.includes(kind)
  }

  function kindDir(kind) {
    return path.join(rootDir, kind)
  }

  function filePath(kind, fileName) {
    return path.join(rootDir, kind, fileName)
  }

  /** 同步读取文件大小；不存在或不是普通文件时返回 0 */
  function sizeOfSync(file) {
    try {
      const stat = fs.statSync(file)
      return stat.isFile() ? stat.size : 0
    } catch {
      return 0
    }
  }

  /** 某文件的期望大小：优先使用本次会话用 content-length 校准过的值 */
  function expectedOf(kind, file) {
    if (file.bytes > 0) {
      const calibratedBytes = calibrated.get(`${kind}/${file.name}`)
      return calibratedBytes > 0 ? calibratedBytes : file.bytes
    }
    return 0
  }

  /** 单文件是否就绪：存在、非空、且（若有期望值）大小在 2% 误差内 */
  function isFileReady(kind, file) {
    const size = sizeOfSync(filePath(kind, file.name))
    if (size <= 0) return false
    const expected = expectedOf(kind, file)
    if (expected <= 0) return true
    return Math.abs(size - expected) <= toleranceOf(expected)
  }

  /** 汇总单个模型的安装信息 */
  function assetStatus(kind) {
    const spec = ASSETS[kind]
    let totalBytes = 0
    const files = spec.files.map((file) => {
      const size = sizeOfSync(filePath(kind, file.name))
      const exists = size > 0
      if (exists) totalBytes += size
      return { name: file.name, bytes: exists ? size : 0, exists }
    })
    const installed = files.every((file) => file.exists)
    const ready = spec.files.every((file) => isFileReady(kind, file))
    return { installed, ready, bytes: totalBytes, title: spec.title, files }
  }

  /** 查询整体状态（同步方法，便于 UI 直接轮询） */
  function status() {
    const assets = {}
    for (const kind of KINDS) assets[kind] = assetStatus(kind)
    return {
      dir: rootDir,
      assets,
      downloading: downloading ? { ...downloading } : null
    }
  }

  /** 各模型文件的绝对路径（未安装时同样返回路径，供推理侧拼装参数） */
  function paths() {
    const result = {}
    for (const kind of KINDS) {
      const entry = {}
      for (const file of ASSETS[kind].files) entry[fileKeyOf(file.name)] = filePath(kind, file.name)
      result[kind] = entry
    }
    return result
  }

  /** 各模型是否全部就绪 */
  function ready() {
    const result = {}
    for (const kind of KINDS) result[kind] = ASSETS[kind].files.every((file) => isFileReady(kind, file))
    return result
  }

  /** 删除临时文件（失败忽略，不额外报错） */
  async function removeQuietly(file) {
    try {
      await fsp.rm(file, { force: true })
    } catch {
      /* 清理失败不影响主流程 */
    }
  }

  /** 当前进度对应的百分比（未知总大小时返回 0） */
  function percentOf(received, total) {
    if (!(total > 0)) return 0
    return Math.min(100, Math.round((received / total) * 1000) / 10)
  }

  /**
   * 把响应体流式写入文件
   * @param {Response} response        fetch 响应
   * @param {object} options
   * @param {string} options.file      目标文件
   * @param {number|null} options.start 写入起始偏移（分段下载用，null = 从头写）
   * @param {(delta:number)=>void} [options.onChunk] 每收到一块数据回调
   * @returns {Promise<number>} 实际写入字节数
   */
  async function pipeBodyToFile(response, { file, start = null, onChunk }) {
    const streamOptions = start == null ? {} : { flags: 'r+', start }
    const stream = fs.createWriteStream(file, streamOptions)
    let streamError = null
    stream.on('error', (error) => {
      streamError = error
    })
    const writeChunk = (chunk) => new Promise((resolve, reject) => {
      stream.write(chunk, (error) => (error ? reject(error) : resolve()))
    })

    let written = 0
    try {
      const body = response.body
      if (body && typeof body.getReader === 'function') {
        // 浏览器 / undici 的 ReadableStream
        const reader = body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value || !value.byteLength) continue
          const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          written += chunk.length
          await writeChunk(chunk)
          if (onChunk) onChunk(chunk.length)
        }
      } else if (body && typeof body[Symbol.asyncIterator] === 'function') {
        // Node 的 Readable 或其他异步可迭代对象
        for await (const raw of body) {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
          if (!chunk.length) continue
          written += chunk.length
          await writeChunk(chunk)
          if (onChunk) onChunk(chunk.length)
        }
      } else {
        // 兜底：整体读入（仅小文件会走到这里）
        const buffer = Buffer.from(await response.arrayBuffer())
        written = buffer.length
        if (buffer.length) await writeChunk(buffer)
        if (onChunk) onChunk(buffer.length)
      }
      await new Promise((resolve) => stream.end(resolve))
      if (streamError) throw streamError
      return written
    } catch (error) {
      stream.destroy()
      throw new Error(friendlyError(error))
    }
  }

  /**
   * 下载单个文件（分段或单连接），先写 `<file>.part`，校验通过后重命名为正式文件
   * @returns {Promise<number>} 最终文件字节数
   */
  async function downloadOne(kind, file, state, onProgress) {
    const target = filePath(kind, file.name)
    const partPath = `${target}.part`
    const expected = expectedOf(kind, file)

    state.fileName = file.name
    state.received = 0
    state.total = expected > 0 ? expected : 0
    state.percent = 0

    let lastBytes = 0
    let lastTime = Date.now()
    const emit = (force) => {
      state.percent = percentOf(state.received, state.total)
      const now = Date.now()
      if (!force && state.received - lastBytes < PROGRESS_BYTES_STEP && now - lastTime < PROGRESS_TIME_STEP) return
      lastBytes = state.received
      lastTime = now
      if (typeof onProgress === 'function') {
        try {
          onProgress({
            kind,
            fileName: file.name,
            received: state.received,
            total: state.total,
            percent: state.percent
          })
        } catch {
          /* 回调自身的异常不影响下载 */
        }
      }
    }

    // ① 用 HEAD 探测真实大小与是否支持分段（失败则退回单连接）
    let contentLength = 0
    let acceptRanges = false
    try {
      const headSignal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(HEAD_TIMEOUT_MS)
        : undefined
      const head = await doFetch(file.url, headSignal ? { method: 'HEAD', signal: headSignal } : { method: 'HEAD' })
      if (head && Number(head.status) >= 200 && Number(head.status) < 300) {
        const rawLength = head.headers && typeof head.headers.get === 'function' ? head.headers.get('content-length') : null
        contentLength = Number(rawLength) || 0
        const rawRanges = head.headers && typeof head.headers.get === 'function' ? head.headers.get('accept-ranges') : null
        acceptRanges = String(rawRanges || '').toLowerCase().includes('bytes')
      }
    } catch {
      contentLength = 0
      acceptRanges = false
    }

    const declaredTotal = contentLength > 0 ? contentLength : expected
    if (declaredTotal > 0) state.total = declaredTotal

    const plan = acceptRanges && contentLength > 0 ? planChunks(contentLength) : null
    logger?.info?.(plan
      ? `分段下载 ${file.name}（${plan.length} 段，共 ${contentLength} 字节）`
      : `单连接下载 ${file.name}`)

    const overall = new AbortController()

    try {
      if (plan) {
        // ② 分段并发：先按总大小建好 .part，再按偏移并发写入
        await fsp.writeFile(partPath, Buffer.alloc(0))
        await fsp.truncate(partPath, contentLength)
        let failure = null
        await Promise.all(plan.map((piece) => (async () => {
          const idle = createIdleController(IDLE_TIMEOUT_MS)
          try {
            const signal = combineSignals(overall.signal, idle.signal)
            const response = await doFetch(file.url, {
              headers: { range: `bytes=${piece.start}-${piece.end}` },
              signal
            })
            if (!response) throw new Error('下载失败，请检查网络后重试')
            if (Number(response.status) !== 206) throw new Error('下载失败（镜像不支持分段传输）')
            const written = await pipeBodyToFile(response, {
              file: partPath,
              start: piece.start,
              onChunk: (delta) => {
                state.received += delta
                idle.touch()
                emit(false)
              }
            })
            if (written !== piece.length) throw new Error('下载的文件不完整')
          } catch (error) {
            failure = failure || new Error(friendlyError(error))
            overall.abort()
          } finally {
            idle.stop()
          }
        })()))
        if (failure) throw failure
      } else {
        // ③ 单连接流式下载
        const idle = createIdleController(IDLE_TIMEOUT_MS)
        try {
          const response = await doFetch(file.url, { signal: idle.signal })
          if (!response) throw new Error('下载失败，请检查网络后重试')
          const statusCode = Number(response.status == null ? 200 : response.status)
          if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300) {
            throw new Error(`下载失败（镜像返回 ${Number.isFinite(statusCode) ? statusCode : '未知状态'}）`)
          }
          if (!(state.total > 0)) {
            const rawLength = response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-length') : null
            const responseLength = Number(rawLength) || 0
            if (responseLength > 0) state.total = responseLength
          }
          await pipeBodyToFile(response, {
            file: partPath,
            onChunk: (delta) => {
              state.received += delta
              idle.touch()
              emit(false)
            }
          })
        } finally {
          idle.stop()
        }
      }

      // ④ 校验：文件存在、非空、大小符合预期、SHA-256 与官方一致（防镜像文件被替换）
      let actualSize = 0
      try {
        const stat = await fsp.stat(partPath)
        actualSize = stat.isFile() ? stat.size : 0
      } catch {
        actualSize = 0
      }
      if (actualSize <= 0) throw new Error('下载的文件为空')
      if (contentLength > 0 && actualSize !== contentLength) throw new Error('下载的文件不完整')
      if (expected > 0 && Math.abs(actualSize - expected) > toleranceOf(expected)) {
        const calibratedByLength = contentLength > 0 && actualSize === contentLength
        if (calibratedByLength) {
          // 镜像给出的 content-length 与清单略有差异时，以实际响应为准并记录
          calibrated.set(`${kind}/${file.name}`, actualSize)
          logger?.warn?.(`模型文件大小与清单略有差异，已按响应头校准：${file.name}（清单 ${expected} 字节，实际 ${actualSize} 字节）`)
        } else {
          throw new Error(`文件大小校验失败（期望约 ${expected} 字节，实际 ${actualSize} 字节）`)
        }
      }
      if (typeof file.sha256 === 'string' && file.sha256 !== '') {
        const actualHash = await sha256File(partPath)
        if (actualHash !== file.sha256.toLowerCase()) {
          logger?.warn?.(`模型文件 SHA-256 与清单不一致：${file.name}（实际 ${actualHash}）`)
          throw new Error(`模型文件校验失败（${file.name} 的 SHA-256 与官方不一致），已删除下载结果，请重试`)
        }
      }

      // ⑤ 落正式文件
      await fsp.rename(partPath, target)
      state.received = actualSize
      if (state.total > 0) state.percent = 100
      emit(true)
      return actualSize
    } catch (error) {
      overall.abort()
      await removeQuietly(partPath)
      throw new Error(friendlyError(error))
    }
  }

  /**
   * 下载指定模型
   * @param {'paraformer'|'segmentation'|'campplus'} kind
   * @param {(progress:{kind:string,fileName:string,received:number,total:number,percent:number})=>void} [onProgress]
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async function download(kind, onProgress) {
    if (!isKind(kind)) return { ok: false, error: '未知的模型类型' }
    if (process.env.DSH_MEETING_NO_DOWNLOAD === '1') return { ok: false, error: '测试模式不下载' }
    if (downloading) return { ok: false, error: '已有下载任务在进行' }

    const spec = ASSETS[kind]
    if (ready()[kind]) {
      logger?.info?.(`模型已就绪，无需下载：${spec.title}`)
      return { ok: true }
    }

    const pending = spec.files.find((file) => !isFileReady(kind, file))
    const state = {
      kind,
      received: 0,
      total: pending && pending.bytes > 0 ? pending.bytes : 0,
      percent: 0,
      fileName: pending ? pending.name : ''
    }
    downloading = state
    try {
      await fsp.mkdir(kindDir(kind), { recursive: true })
      logger?.info?.(`开始下载模型：${spec.title}`)
      for (const file of spec.files) {
        if (isFileReady(kind, file)) continue
        await downloadOne(kind, file, state, onProgress)
      }
      if (!ready()[kind]) {
        logger?.warn?.(`模型下载后校验未通过：${spec.title}`)
        return { ok: false, error: '模型校验未通过，请重试下载' }
      }
      logger?.info?.(`模型下载完成：${spec.title}`)
      return { ok: true }
    } catch (error) {
      logger?.warn?.(`模型下载失败：${spec.title}`)
      return { ok: false, error: friendlyError(error) }
    } finally {
      downloading = null
    }
  }

  /**
   * 删除指定模型的本地文件
   * @param {'paraformer'|'segmentation'|'campplus'} kind
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async function remove(kind) {
    if (!isKind(kind)) return { ok: false, error: '未知的模型类型' }
    if (downloading && downloading.kind === kind) return { ok: false, error: '下载进行中，无法删除' }
    try {
      await fsp.rm(kindDir(kind), { recursive: true, force: true })
      for (const key of Array.from(calibrated.keys())) {
        if (key.startsWith(`${kind}/`)) calibrated.delete(key)
      }
      logger?.info?.(`已删除本地模型：${ASSETS[kind].title}`)
      return { ok: true }
    } catch {
      return { ok: false, error: '删除模型失败，请检查文件是否被占用' }
    }
  }

  return { status, download, remove, paths, ready }
}
