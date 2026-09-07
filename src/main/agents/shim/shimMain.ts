/**
 * PATH shim 的运行时。由 commandShim.ts 生成的小脚本以
 * `<node> shimMain.js <命令名> <原样参数…>` 的形式调起来,跑在 **agent 的进程环境里**。
 *
 * 它只做四件事,刻意做得很笨 —— 判断全在主进程(authPolicy),这边只负责问和转发:
 *   1. 连上中枢,报「我是谁、要干什么、在哪儿」
 *   2. 等一个 allow / deny
 *   3. allow → exec 真身,原样透传 stdio 和退出码,**就像 shim 不存在一样**
 *   4. deny → 往 stderr 写一句人话,非零退出(模型会读到,并把它汇报给用户)
 *
 * ★★连不上中枢时**拒绝执行**,不是放行。这一层的存在意义就是「没问过就不许跑」,
 *  失败时放行等于这层从未存在。而且失败是**响的**:模型拿到明确的错误,会说出来。
 * ★这个文件不能 import 任何主进程的东西 —— 它被单独打包成一个 .js,跑在 agent 环境里。
 */
import net from 'node:net'
import { spawn } from 'node:child_process'
import { realBinaryPath } from '../commandShim'

interface Answer { decision?: string; message?: string }

function ask(sock: string, payload: unknown): Promise<Answer> {
  return new Promise((resolve) => {
    let buf = ''
    let settled = false
    const done = (a: Answer) => { if (!settled) { settled = true; resolve(a) } }
    const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\n'))
    c.on('data', (d) => {
      buf += d.toString()
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      try { done(JSON.parse(buf.slice(0, nl)) as Answer) } catch { done({ decision: 'deny', message: '授权服务返回了无法解析的内容' }) }
      c.end()
    })
    c.on('error', (e) => done({ decision: 'deny', message: `连不上 Forge 的授权服务：${e.message}` }))
    // ★不设超时:用户可能真的在想。看门狗那边已经改成「先报告、半小时才回收」,
    //  所以这里一直等是安全的,而且比自作主张放行或拒绝都好。
  })
}

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0]
  const rest = argv.slice(1)
  const sock = process.env.FORGE_AUTH_SOCK
  const shimDir = process.env.FORGE_SHIM_DIR ?? ''
  const real = realBinaryPath(cmd, shimDir, process.env.PATH)
  if (!real) { process.stderr.write(`forge: 找不到 ${cmd}\n`); return 127 }

  if (sock) {
    const a = await ask(sock, { type: 'exec', sessionId: process.env.FORGE_SESSION_ID ?? '', command: cmd, argv: rest, cwd: process.cwd() })
    if (a.decision !== 'allow') {
      process.stderr.write(`forge: 已拒绝执行 ${cmd}${a.message ? `（${a.message}）` : ''}\n`)
      return 126
    }
  }
  return await run(real, rest)
}

function run(bin: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: 'inherit' })
    child.on('error', (e) => { process.stderr.write(`forge: ${e.message}\n`); resolve(127) })
    // ★被信号打断时按 shell 的老规矩报 128+signo —— 上游脚本靠退出码判断是不是被 Ctrl-C 掉的。
    child.on('exit', (code, signal) => resolve(signal ? 128 + (osSignal(signal) ?? 0) : code ?? 0))
  })
}

const SIGNOS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGPIPE: 13 }
function osSignal(sig: string): number | undefined { return SIGNOS[sig] }

/* c8 ignore start — 入口,单测直接调 main() */
if (require.main === module) {
  void main(process.argv.slice(2)).then((c) => process.exit(c))
}
/* c8 ignore stop */
