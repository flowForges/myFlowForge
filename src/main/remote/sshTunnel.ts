import { createServer, connect as netConnect } from 'node:net'
import { execa, type ResultPromise } from 'execa'

/** `user@host` / `user@host:2222` → 拆出端口(ssh 的端口要用 -p 传,不能塞在地址里)。 */
export function parseSshTarget(t: string): { userHost: string; port?: number } {
  const raw = t.trim()
  // IPv6 字面量写成 user@[::1]:2222
  const m = /^(.*?)(?::(\d+))?$/.exec(raw)
  if (!m) return { userHost: raw }
  const port = m[2] ? Number(m[2]) : undefined
  return { userHost: m[1] ?? raw, ...(port ? { port } : {}) }
}

/** 找一个当前空着的本地端口:让内核随便给一个,记下来再放掉。 */
export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.once('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address()
      const p = typeof a === 'object' && a ? a.port : 0
      srv.close(() => (p ? res(p) : rej(new Error('拿不到空闲端口'))))
    })
  })
}

/** 本地端口通不通 —— 隧道是否真的建起来了,以此为准,不靠 ssh 的输出猜。 */
export function probePort(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((res) => {
    const s = netConnect({ port, host: '127.0.0.1' })
    const done = (ok: boolean) => { try { s.destroy() } catch { /* 已销毁 */ } res(ok) }
    s.setTimeout(timeoutMs)
    s.once('connect', () => done(true))
    s.once('timeout', () => done(false))
    s.once('error', () => done(false))
  })
}

export type Tunnel = { localPort: number; close(): Promise<void> }

/**
 * 拉一条 `ssh -N -L <本地>:127.0.0.1:<远端>` 隧道。
 *
 * 为什么是 SSH 而不是让 daemon 开一个对外端口(决策 B-3):那个端口一旦被敲开,对方拿到的是
 * 「起 agent + 替你答权限门 + 开终端」= 整台机器的控制权。SSH 的安全性经过二十多年检验,
 * 比临时写的任何鉴权都可靠,而且第三期中转上线后这条路依然有效,没有一行是废弃的过渡代码。
 *
 * ★不加 `BatchMode=yes`:那会让密码认证直接失败。但没有 TTY 也答不了密码提示 ——
 * 实际要求就是**密钥认证**,所以超时的错误信息里必须把这句说出来,否则用户只会看到「超时」。
 */
export async function openSshTunnel(opts: {
  target: string
  /** 远端 daemon 在**它自己机器上**监听的端口 */
  remotePort: number
  remoteHost?: string
  timeoutMs?: number
  spawnProc?: (cmd: string, args: string[]) => ResultPromise
  probe?: (port: number) => Promise<boolean>
  onLog?: (m: string) => void
}): Promise<Tunnel> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const probe = opts.probe ?? probePort
  const log = opts.onLog ?? (() => {})
  const { userHost, port } = parseSshTarget(opts.target)
  const localPort = await freePort()

  const args = [
    '-N', '-T',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',
    '-L', `${localPort}:${opts.remoteHost ?? '127.0.0.1'}:${opts.remotePort}`,
    ...(port ? ['-p', String(port)] : []),
    userHost,
  ]
  log(`ssh ${args.join(' ')}`)
  const spawnProc = opts.spawnProc ?? ((cmd, a) => execa(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'] }))
  const proc = spawnProc('ssh', args)

  // 用对象包一层:TS 的控制流分析看不见异步回调里的赋值,`let` 会被窄化成 never。
  const state: { exited: string | null } = { exited: null }
  // execa 在进程非零退出时 reject。这里只记下来 —— 它是「隧道没建起来」的原因,
  // 不接住的话会变成一个没人处理的 rejection。
  void proc.catch((e: unknown) => { state.exited = e instanceof Error ? e.message : String(e) })
  void proc.then(() => { state.exited ??= 'ssh 已退出' }, () => {})

  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await probe(localPort)) break
    if (state.exited) {
      throw new Error(`SSH 隧道没能建立:${state.exited.split('\n').slice(0, 3).join(' ')}`)
    }
    if (Date.now() > deadline) {
      try { proc.kill('SIGTERM') } catch { /* 已退出 */ }
      throw new Error('SSH 隧道超时。请确认这台机器能免密登录该服务器(密钥认证)——没有终端可以输入密码。')
    }
    await new Promise((r) => setTimeout(r, 150))
  }

  return {
    localPort,
    async close() {
      try { proc.kill('SIGTERM') } catch { /* 已退出 */ }
      await Promise.race([proc.catch(() => {}), new Promise((r) => setTimeout(r, 2000))])
    },
  }
}
