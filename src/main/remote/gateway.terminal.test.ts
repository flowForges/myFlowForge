import { describe, it, expect, afterEach } from 'vitest'
import { startGateway } from './gateway'
import { connectRemote, type RemoteState } from './remoteClient'
import { createBroadcastHub } from '../ipc/broadcastHub'
import { createTerminalService } from '../terminal/terminalService'
import { CH } from '../ipc/channels'
import type { MethodTable } from '../ipc/invokeCtx'

/**
 * **终端跑在 host 上,界面跑在客户端上** —— 真网关 + 真客户端把这句话走一遍。
 *
 * ★★这个文件存在的理由:在此之前 `term:*` 是 `src/main/index.ts` 里直接 `ipcMain.handle` 注册的,
 *  **没进方法表**。于是连着远程主机时,终端面板里开出来的是**你面前这台**的 shell,不是你连的那台
 *  (界面上挂了一句「本机 · 非 XX」如实说明,但功能等于没有)。这条路上有三件事只有真连接才验得到:
 *
 * 1. `term:write` 以前是 `ipcMain.on`(**单向**),而单向消息压根不经过主机路由器 ——
 *    改成 invoke 之后它才会走到对面那台机器。
 * 2. 输出是**只回给发起方**的(`ctx.emit`),不是广播 —— 单元测试里的假 ctx 证明不了
 *    真连接上也是这样。
 * 3. 连接断了要把 pty 收掉。没有真连接就没有"断"这回事,而这条漏了的后果是
 *    **服务器上攒下一堆永不退出的 shell**,几周后表现成「终端打不开了」。
 */

const closers: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const c of closers.splice(0)) await c() })

function fakePty() {
  const p = {
    pid: 4321, written: [] as string[], killed: false,
    _data: (_d: string) => {}, _exit: (_e: { exitCode: number }) => {},
    onData(cb: (d: string) => void) { p._data = cb },
    onExit(cb: (e: { exitCode: number; signal?: number }) => void) { p._exit = cb },
    write(d: string) { p.written.push(d) },
    resize() {}, kill() { p.killed = true },
  }
  return p
}

/** 一台 host:真网关 + 真终端服务(pty 是假的 —— 这里验的是链路,不是 node-pty)。 */
async function host() {
  const ptys: ReturnType<typeof fakePty>[] = []
  const term = createTerminalService({
    spawn: () => { const p = fakePty(); ptys.push(p); return p },
    exists: () => true, home: '/home/me', schedule: (cb) => cb(),
  })
  const table: MethodTable = {}
  term.register(table)
  const hub = createBroadcastHub()
  const gw = await startGateway({ table, addSink: hub.addSink, version: '1.2.0', port: 0 })
  closers.push(() => gw.close())
  return { gw, ptys, term }
}

/** 一个真客户端,连到那台 host 上。 */
function client(port: number) {
  const events: { ch: string; payload: any }[] = []
  const c = connectRemote({
    url: `ws://127.0.0.1:${port}`, clientVersion: '1.2.0', backoff: false, readyTimeoutMs: 4000,
    onEvent: (ch, payload) => { events.push({ ch, payload }) },
  })
  closers.push(() => c.close())
  const ready = () => new Promise<void>((res, rej) => {
    if (c.state().status === 'ready') return res()
    const t = setTimeout(() => rej(new Error(`没 ready:${JSON.stringify(c.state())}`)), 4000)
    const off = c.onState((s: RemoteState) => {
      if (s.status === 'ready') { clearTimeout(t); off(); res() }
      if (s.status === 'failed') { clearTimeout(t); off(); rej(new Error(JSON.stringify(s))) }
    })
  })
  return {
    ready, events, close: () => c.close(), state: () => c.state(),
    invoke: (ch: string, args: unknown[]) => c.invoke(ch, args),
    of: (ch: string) => events.filter(e => e.ch === ch).map(e => e.payload),
  }
}

/** 事件是异步推过来的,给它一个真实的等待而不是固定 sleep。 */
const eventually = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`等不到:${what}`)
}

describe('终端走远程连接', () => {
  it('握手时报出来的方法清单里就有 term:* —— 客户端据此决定入口要不要置灰', async () => {
    // 客户端拿这份清单决定「这台机器提供不提供终端」。少了它,面板会被置灰,
    // 而且路由器会直接抛「不提供这个功能」——所以这条断言比看起来重要。
    const h = await host()
    const c = client(h.gw.port)
    await c.ready()
    const st = c.state()
    expect(st.status).toBe('ready')
    const methods = st.status === 'ready' ? st.methods : new Set<string>()
    for (const ch of [CH.termCreate, CH.termWrite, CH.termResize, CH.termKill]) {
      expect(methods.has(ch), `${ch} 应该在 ready 的方法清单里`).toBe(true)
    }
  })

  it('开一个终端 → shell 起在 host 上,输出经这条连接回到客户端', async () => {
    const h = await host()
    const c = client(h.gw.port)
    await c.ready()

    expect(await c.invoke(CH.termCreate, [{ termId: 'term-1', cwd: '/w', cols: 80, rows: 24 }])).toEqual({ ok: true })
    expect(h.ptys).toHaveLength(1)

    h.ptys[0]._data('$ ls\nREADME.md\n')
    await eventually(() => c.of(CH.termData).length > 0, 'term:data 推回客户端')
    expect(c.of(CH.termData)[0]).toEqual({ termId: 'term-1', data: '$ ls\nREADME.md\n' })
  })

  it('★敲进去的字节到的是 host 那台的 shell —— 这正是以前坏掉的那一半', async () => {
    // `term:write` 原来是 `ipcMain.on`(单向)。单向消息不经过路由器,所以连着远程主机时
    // 敲下去的每一个字符其实写进了**本机**那个 pty。改成 invoke 才有这条路。
    const h = await host()
    const c = client(h.gw.port)
    await c.ready()
    await c.invoke(CH.termCreate, [{ termId: 'term-1', cols: 80, rows: 24 }])
    await c.invoke(CH.termWrite, [{ termId: 'term-1', data: 'npm test\n' }])
    expect(h.ptys[0].written).toEqual(['npm test\n'])
  })

  it('★两台客户端连同一台 host,各自的 `term-1` 互不相干', async () => {
    // 两边的 termId 都是各自的渲染层从 1 开始编的,撞号是必然而不是巧合。
    const h = await host()
    const a = client(h.gw.port)
    const b = client(h.gw.port)
    await a.ready(); await b.ready()

    await a.invoke(CH.termCreate, [{ termId: 'term-1', cols: 80, rows: 24 }])
    await b.invoke(CH.termCreate, [{ termId: 'term-1', cols: 80, rows: 24 }])
    expect(h.ptys).toHaveLength(2)
    expect(h.ptys[0].killed).toBe(false)          // B 开的时候没把 A 的顶掉

    h.ptys[0]._data('A 的私密输出')
    await eventually(() => a.of(CH.termData).length > 0, 'A 收到自己的输出')
    // 再等一会儿:要证明的是 B **永远**收不到,不是「还没收到」
    await new Promise(r => setTimeout(r, 60))
    expect(b.of(CH.termData)).toEqual([])

    await b.invoke(CH.termWrite, [{ termId: 'term-1', data: 'x' }])
    expect(h.ptys[0].written).toEqual([])
    expect(h.ptys[1].written).toEqual(['x'])
  })

  it('★★客户端断开 → 它在 host 上开的 pty 全部收掉,别人的不动', async () => {
    // 没有这一刀,Linux daemon 上每断一次线就留一个永远不会退出的 shell。
    const h = await host()
    const a = client(h.gw.port)
    const b = client(h.gw.port)
    await a.ready(); await b.ready()
    await a.invoke(CH.termCreate, [{ termId: 'term-1', cols: 80, rows: 24 }])
    await a.invoke(CH.termCreate, [{ termId: 'term-2', cols: 80, rows: 24 }])
    await b.invoke(CH.termCreate, [{ termId: 'term-1', cols: 80, rows: 24 }])
    expect(h.term.size()).toBe(3)

    await a.close()

    await eventually(() => h.term.size() === 1, 'A 的两个 pty 被收掉')
    expect(h.ptys[0].killed).toBe(true)
    expect(h.ptys[1].killed).toBe(true)
    expect(h.ptys[2].killed).toBe(false)          // B 还连着
  })

  it('host 上的 shell 退出 → 客户端收到 term:exit(不是干等着)', async () => {
    const h = await host()
    const c = client(h.gw.port)
    await c.ready()
    await c.invoke(CH.termCreate, [{ termId: 'term-1', cols: 80, rows: 24 }])
    h.ptys[0]._exit({ exitCode: 130 })
    await eventually(() => c.of(CH.termExit).length > 0, 'term:exit 推回客户端')
    expect(c.of(CH.termExit)[0]).toMatchObject({ termId: 'term-1', exitCode: 130 })
  })
})
