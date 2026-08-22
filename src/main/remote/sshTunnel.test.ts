import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import { freePort, parseSshTarget, probePort, openSshTunnel } from './sshTunnel'

// 假 ssh 进程:execa 返回的东西是「一个 promise + 一个可以 kill 的对象」,这里只需要这两面。
function fakeProc(behaviour: { failAfterMs?: number; message?: string } = {}) {
  const killed: string[] = []
  const p: any = new Promise((res, rej) => {
    if (behaviour.failAfterMs !== undefined) {
      setTimeout(() => rej(new Error(behaviour.message ?? 'ssh: Could not resolve hostname')), behaviour.failAfterMs)
    }
  })
  p.kill = (sig: string) => { killed.push(sig); return true }
  p.killed = killed
  Object.assign(p, EventEmitter.prototype)
  return p
}

describe('parseSshTarget', () => {
  it.each([
    ['zghua@1.2.3.4', { userHost: 'zghua@1.2.3.4' }],
    ['zghua@1.2.3.4:2222', { userHost: 'zghua@1.2.3.4', port: 2222 }],
    ['myserver', { userHost: 'myserver' }],
    ['  root@example.com  ', { userHost: 'root@example.com' }],
  ])('%s', (input, want) => { expect(parseSshTarget(input)).toEqual(want) })
})

describe('freePort / probePort', () => {
  it('freePort 给的端口当时确实是空的', async () => {
    const p = await freePort()
    expect(p).toBeGreaterThan(0)
    expect(await probePort(p, 200)).toBe(false)
  })

  it('有人在听的端口 probe 得到 true', async () => {
    const port = await freePort()
    const srv = createServer()
    await new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r()))
    try { expect(await probePort(port, 500)).toBe(true) }
    finally { await new Promise<void>((r) => srv.close(() => r())) }
  })
})

describe('openSshTunnel', () => {
  it('端口通了就算隧道建好,并把命令拼对', async () => {
    let seen: string[] = []
    const t = await openSshTunnel({
      target: 'zghua@1.2.3.4:2222',
      remotePort: 6767,
      spawnProc: (_cmd, args) => { seen = args; return fakeProc() },
      probe: async () => true,
    })
    expect(seen).toContain('-N')
    expect(seen).toContain('ExitOnForwardFailure=yes')
    expect(seen.join(' ')).toContain(`-L ${t.localPort}:127.0.0.1:6767`)
    expect(seen.join(' ')).toContain('-p 2222')
    expect(seen[seen.length - 1]).toBe('zghua@1.2.3.4')
    await t.close()
  })

  it('★ssh 自己先退了 → 立刻带着它的原话报错,不用干等到超时', async () => {
    // 主机名打错这种情况 ssh 一秒就退了。傻等 15 秒才说「超时」是最难查的那种体验。
    await expect(openSshTunnel({
      target: 'zghua@nope',
      remotePort: 6767,
      spawnProc: () => fakeProc({ failAfterMs: 10, message: 'ssh: Could not resolve hostname nope' }),
      probe: async () => false,
      timeoutMs: 5000,
    })).rejects.toThrow(/Could not resolve hostname/)
  })

  it('★一直不通 → 超时,且错误信息点出「要免密登录」', async () => {
    // 没有 TTY 就答不了密码提示,这是真正的原因。只说「超时」用户会去查网络。
    await expect(openSshTunnel({
      target: 'zghua@1.2.3.4',
      remotePort: 6767,
      spawnProc: () => fakeProc(),
      probe: async () => false,
      timeoutMs: 200,
    })).rejects.toThrow(/免密登录/)
  })

  it('close 会去杀 ssh 进程', async () => {
    const proc = fakeProc()
    const t = await openSshTunnel({
      target: 'a@b', remotePort: 1, spawnProc: () => proc, probe: async () => true,
    })
    await t.close()
    expect(proc.killed).toContain('SIGTERM')
  })
})
