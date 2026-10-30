// grep 的正则在 worker 线程里跑(spec §7、§16.7):模型给的正则可能灾难回溯,放主线程会卡死整个内核;
// 超时或取消 → worker.terminate()。源码内联(eval),打包后不依赖额外文件
import { constants } from 'node:fs'
import { Worker } from 'node:worker_threads'

export const MAX_FILE_BYTES = 2 * 1024 * 1024
const SNIFF_BYTES = 8 * 1024

/** worker 源码(CommonJS);每找到一条就发回,超时时主线程手里有部分结果 */
export const GREP_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const path = require('node:path')
const { files, base, pattern, flags, maxMatches, maxLine, maxBytes, sniff, nofollow } = workerData
const re = new RegExp(pattern, flags.replace(/[gy]/g, ''))
const fold = process.platform === 'darwin' || process.platform === 'win32'
const same = (a, b) => (fold ? a.toLowerCase() === b.toLowerCase() : a === b)
let n = 0
for (const f of files) {
  if (n >= maxMatches) break
  let fd
  try {
    // 中间段在过门后被换成链接 → realpath 不再是它自己,不读
    if (!same(fs.realpathSync.native(f), f)) continue
    fd = fs.openSync(f, fs.constants.O_RDONLY | nofollow | (fs.constants.O_NONBLOCK || 0)) // FIFO 不会卡住线程
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.size > maxBytes) continue
    const buf = fs.readFileSync(fd)
    if (buf.length > maxBytes || buf.subarray(0, sniff).includes(0)) continue
    const rel = base ? path.relative(base, f) : ''
    const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : f
    const lines = buf.toString('utf8').split(/\\r?\\n/)
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        parentPort.postMessage({ type: 'match', line: shown + ':' + (i + 1) + ': ' + lines[i].slice(0, maxLine) })
        if (++n >= maxMatches) break
      }
    }
  } catch {
    // 读不了的文件跳过
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
}
parentPort.postMessage({ type: 'done' })
`

export interface GrepJob {
  /** 绝对路径 */
  files: string[]
  /** 输出里的路径相对它;不给 → 绝对路径 */
  base?: string
  pattern: string
  flags: string
  maxMatches: number
  maxLine: number
}

export interface GrepResult {
  matches: string[]
  timedOut: boolean
  aborted: boolean
  error?: string
}

export function runGrep(job: GrepJob, opts: { timeoutMs?: number; signal: AbortSignal }): Promise<GrepResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const matches: string[] = []
  if (opts.signal.aborted) return Promise.resolve({ matches, timedOut: false, aborted: true })
  return new Promise(resolve => {
    let settled = false
    const worker = new Worker(GREP_WORKER_SOURCE, {
      eval: true,
      workerData: { ...job, maxBytes: MAX_FILE_BYTES, sniff: SNIFF_BYTES, nofollow: constants.O_NOFOLLOW ?? 0 },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    })
    const finish = (r: Omit<GrepResult, 'matches'>, kill: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
      const done = () => resolve({ matches, ...r })
      if (kill) worker.terminate().then(done, done)
      else done()
    }
    const onAbort = () => finish({ timedOut: false, aborted: true }, true)
    const timer = setTimeout(() => finish({ timedOut: true, aborted: false }, true), timeoutMs)
    opts.signal.addEventListener('abort', onAbort, { once: true })
    worker.on('message', (m: { type: string; line?: string }) => {
      if (m.type === 'match' && m.line !== undefined) matches.push(m.line)
      else if (m.type === 'done') finish({ timedOut: false, aborted: false }, true)
    })
    worker.on('error', (e: Error) => finish({ timedOut: false, aborted: false, error: e.message }, true))
    worker.on('exit', code => finish({ timedOut: false, aborted: false, ...(code !== 0 && { error: `grep 线程异常退出(${code})` }) }, false))
  })
}
