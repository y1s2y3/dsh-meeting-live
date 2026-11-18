/**
 * 声纹分离的**独立进程**入口。
 *
 * 为什么单独起进程：sherpa-onnx 的说话人分离是同步 CPU 计算，1 小时音频在 CPU 上
 * 要跑好几分钟。放在宿主进程里会阻塞 Node 事件循环（页面轮询拿不到进度、整个插件卡住），
 * 所以改成 `electron --run-as-node` 子进程执行，宿主只负责轮询结果/取消。
 *
 * 两种模式：
 *   - 默认（splitTurns=false）：只做说话人分离，返回 `[{ speaker, start, end }]`（宿主用它回填现有分段）；
 *   - `splitTurns=true`：分离后再**按说话人回合逐段识别文本**，返回 `[{ speaker, text, start, end }]`，
 *     适合「原文是 30 秒大段、一句话里混了两个人」的会议（说话人归属更准，但要多花几分钟跑 ASR）。
 *
 * 用法（由宿主 server.js 调起）：
 *   ELECTRON_RUN_AS_NODE=1 <exe> diarize-worker.js <args.json>
 * args.json：`{ audioPath, models, numClusters, outputPath, splitTurns }`
 * 进度：stdout 打印 `STAGE loading|diarizing|transcribing X/Y|done`，
 * 结果写 outputPath JSON：`{ ok: true, speakers, lines, splitTurns }` 或 `{ ok: false, error }`
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createParaformerEngine } from './paraformer.js'

const SAMPLE_RATE = 16000

function writeOutput(outputPath, payload) {
  try {
    writeFileSync(outputPath, JSON.stringify(payload), 'utf8')
  } catch {
    // 结果文件写不了时，宿主会读到空文件并报错，进程退出码同样能说明失败。
  }
}

/** Float32（[-1,1]，16k 单声道）→ PCM16 WAV Buffer。 */
function encodePcm16Wav(samples) {
  const data = Buffer.alloc(samples.length * 2)
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, Number(samples[index]) || 0))
    data.writeInt16LE(Math.round(value < 0 ? value * 0x8000 : value * 0x7fff), index * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

async function main() {
  const argsPath = process.argv[2]
  if (typeof argsPath !== 'string' || argsPath === '') {
    console.error('STAGE error missing args file')
    process.exit(2)
  }
  const args = JSON.parse(readFileSync(argsPath, 'utf8'))
  const outputPath = String(args.outputPath ?? '')
  const splitTurns = args.splitTurns === true
  try {
    const engine = createParaformerEngine({
      models: args.models ?? {},
      logger: { info: (message) => console.log('[worker] ' + String(message)), warn: (message) => console.log('[worker] ' + String(message)) },
    })
    if (engine.diarizationAvailable() !== true) throw new Error('说话人分离模型未就绪：请到设置 → 模型配置里下载 pyannote 分段与 cam++ 声纹模型')
    const numClusters = Number(args.numClusters)
    console.log('STAGE loading')
    const startedAt = Date.now()
    const diarized = engine.diarizeFile(String(args.audioPath ?? ''), {
      numClusters: Number.isFinite(numClusters) && numClusters > 0 ? numClusters : 0,
    })
    console.log('STAGE diarizing ' + String(Math.round((Date.now() - startedAt) / 100) / 10) + 's')
    const lines = Array.isArray(diarized.lines)
      ? diarized.lines.map((line) => ({ speaker: line.speaker, start: line.start, end: line.end }))
      : []
    if (splitTurns === true && lines.length > 0) {
      if (engine.available() !== true) throw new Error('Paraformer 模型未就绪：无法按说话人切句')
      const { samples } = engine.readAudioFile(String(args.audioPath ?? ''))
      for (let index = 0; index < lines.length; index += 1) {
        const from = Math.max(0, Math.floor(lines[index].start * SAMPLE_RATE))
        const to = Math.min(samples.length, Math.ceil(lines[index].end * SAMPLE_RATE))
        let text = ''
        if (to - from >= SAMPLE_RATE * 0.2) {
          try {
            const result = await engine.transcribeWav(encodePcm16Wav(samples.subarray(from, to)))
            text = typeof result?.text === 'string' ? result.text.trim() : ''
          } catch (error) {
            // 单段识别失败（静音/噪声）不影响整体
            if (index % 50 === 0) console.log('[worker] turn ' + String(index) + ' asr skipped: ' + String(error instanceof Error ? error.message : error))
          }
        }
        lines[index].text = text
        if (index % 20 === 0 || index === lines.length - 1) {
          console.log('STAGE transcribing ' + String(index + 1) + '/' + String(lines.length))
        }
      }
    }
    writeOutput(outputPath, { ok: true, speakers: diarized.speakers, lines, splitTurns })
    console.log('STAGE done speakers=' + String(diarized.speakers) + ' turns=' + String(lines.length))
    process.exit(0)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeOutput(outputPath, { ok: false, error: message })
    console.error('STAGE error ' + message)
    process.exit(1)
  }
}

void main()
