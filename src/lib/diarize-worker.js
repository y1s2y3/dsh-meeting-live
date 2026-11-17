/**
 * 声纹分离的**独立进程**入口。
 *
 * 为什么单独起进程：sherpa-onnx 的说话人分离是同步 CPU 计算，1 小时音频在 CPU 上
 * 要跑好几分钟。放在宿主进程里会阻塞 Node 事件循环（页面轮询拿不到进度、整个插件卡住），
 * 所以改成 `electron --run-as-node` 子进程执行，宿主只负责轮询结果/取消。
 *
 * 用法（由宿主 server.js 调起）：
 *   ELECTRON_RUN_AS_NODE=1 <exe> diarize-worker.js <args.json>
 * args.json：`{ audioPath, models, numClusters, outputPath }`
 * 进度：stdout 打印 `STAGE loading|diarizing|done`，结果写 outputPath JSON：
 *   `{ ok: true, speakers, lines: [{ speaker, start, end }] }` 或 `{ ok: false, error }`
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createParaformerEngine } from './paraformer.js'

function writeOutput(outputPath, payload) {
  try {
    writeFileSync(outputPath, JSON.stringify(payload), 'utf8')
  } catch {
    // 结果文件写不了时，宿主会读到空文件并报错，进程退出码同样能说明失败。
  }
}

async function main() {
  const argsPath = process.argv[2]
  if (typeof argsPath !== 'string' || argsPath === '') {
    console.error('STAGE error missing args file')
    process.exit(2)
  }
  const args = JSON.parse(readFileSync(argsPath, 'utf8'))
  const outputPath = String(args.outputPath ?? '')
  try {
    const engine = createParaformerEngine({
      models: args.models ?? {},
      logger: { info: (message) => console.log('[worker] ' + String(message)), warn: (message) => console.log('[worker] ' + String(message)) },
    })
    if (engine.diarizationAvailable() !== true) throw new Error('说话人分离模型未就绪：请到设置 → 模型配置里下载 pyannote 分段与 cam++ 声纹模型')
    const numClusters = Number(args.numClusters)
    console.log('STAGE loading')
    const startedAt = Date.now()
    const result = engine.diarizeFile(String(args.audioPath ?? ''), {
      numClusters: Number.isFinite(numClusters) && numClusters > 0 ? numClusters : 0,
    })
    console.log('STAGE diarizing ' + String(Math.round((Date.now() - startedAt) / 100) / 10) + 's')
    writeOutput(outputPath, { ok: true, speakers: result.speakers, lines: result.lines })
    console.log('STAGE done speakers=' + String(result.speakers) + ' turns=' + String(result.lines.length))
    process.exit(0)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeOutput(outputPath, { ok: false, error: message })
    console.error('STAGE error ' + message)
    process.exit(1)
  }
}

void main()
