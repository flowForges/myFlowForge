import { describe, it, expect, vi } from 'vitest'
import { createTerminalService, type TerminalSpawn } from './terminalService'
import { CH } from '../ipc/channels'
import type { InvokeCtx, MethodTable } from '../ipc/invokeCtx'

/**
 * 这一层特有的三件事(别的方法都没有)各自要有红:**按调用方隔离**、**输出只回给开它的人**、
 * **连接断了把 pty 收掉**。前两件错了会互相串台,第三件错了会在服务器上攒下永不退出的 shell。
 */

/** 一个假 pty:记下收到的字节,能被杀,能主动吐字节。 */
function fakePty() {
  const p = {
    pid: 1234,
    written: [] as string[],
    resized: [] as [number, number][],
    killed: false,
    _data: (_d: string) => {},
    _exit: (_e: { exitCode: number }) => {},
    onData(cb: (d: string) => void) { p._data = cb },
    onExit(cb: (e: { exitCode: number; signal?: number }) => void) { p._exit = cb },
    write(d: string) { p.written.push(d) },
    resize(c: number, r: number) { p.resized.push([c, r]) },
    kill() { p.killed = true },
  }
  return p
}

function harness() {
  const spawned: { cwd: string; pty: ReturnType<typeof fakePty> }[] = []
  const spawn: TerminalSpawn = (_shell, _args, o) => {
    const pty = fakePty()
    spawned.push({ cwd: o.cwd, pty })
    return pty
  }
  const svc = createTerminalService({
    spawn,
    exists: () => true,
    home: '/home/me',
    // 合批窗口同步跑完,免得每条断言都要等 8ms
    schedule: (cb) => cb(),
    // lsof 在测试里永远探不到 —— 走 OSC7 那条主路径就够了
    exec: async () => { throw new Error('no lsof') },
  })
  const table: MethodTable = {}
  svc.register(table)
  return { svc, table, spawned }
}

/** 造一个调用方:记下发回给它的事件,并留出「这条连接断了」的开关。 */
function client(id: string) {
  const got: { channel: string; payload: any }[] = []
  let closers: (() => void)[] = []
  const ctx: InvokeCtx = {
    emit: (channel, payload) => { got.push({ channel, payload }) },
    client: { id, label: id },
    onClose: (cb) => { closers.push(cb) },
  }
  return {
    ctx, got,
    of: (channel: string) => got.filter(g => g.channel === channel),
    disconnect: () => { const cs = closers; closers = []; for (const c of cs) c() },
    closerCount: () => closers.length,
  }
}

describe('终端服务', () => {
  it('开 → 输出回到开它的那个客户端 → 写进去的字节到了 pty', async () => {
    const { table, spawned } = harness()
    const a = client('remote-1')

    expect(await table[CH.termCreate](a.ctx, { termId: 't1', cwd: '/w', cols: 80, rows: 24 })).toEqual({ ok: true })
    expect(spawned[0].cwd).toBe('/w')

    spawned[0].pty._data('hello')
    expect(a.of(CH.termData)).toEqual([{ channel: CH.termData, payload: { termId: 't1', data: 'hello' } }])

    await table[CH.termWrite](a.ctx, { termId: 't1', data: 'ls\n' })
    expect(spawned[0].pty.written).toEqual(['ls\n'])
    await table[CH.termResize](a.ctx, { termId: 't1', cols: 120, rows: 40 })
    expect(spawned[0].pty.resized).toEqual([[120, 40]])
  })

  it('★两台客户端各开一个 `t1`:互相看不见,也顶不掉对方', async () => {
    // termId 是**客户端自己编的**(`term-1`、`term-2`,从 1 开始)。两台客户端连同一台 host
    // 必然撞号 —— 不按调用方隔离的话,后来的那个会把先来的那个 pty 直接杀掉,
    // 而先来的那个人只看到自己的终端毫无征兆地死了。
    const { table, spawned } = harness()
    const a = client('remote-1')
    const b = client('remote-2')

    await table[CH.termCreate](a.ctx, { termId: 't1', cwd: '/a', cols: 80, rows: 24 })
    await table[CH.termCreate](b.ctx, { termId: 't1', cwd: '/b', cols: 80, rows: 24 })

    expect(spawned).toHaveLength(2)
    expect(spawned[0].pty.killed).toBe(false)      // A 的没有被顶掉

    spawned[0].pty._data('A 的输出')
    spawned[1].pty._data('B 的输出')
    expect(a.of(CH.termData).map(g => g.payload.data)).toEqual(['A 的输出'])
    expect(b.of(CH.termData).map(g => g.payload.data)).toEqual(['B 的输出'])

    // 写也各写各的
    await table[CH.termWrite](b.ctx, { termId: 't1', data: 'x' })
    expect(spawned[0].pty.written).toEqual([])
    expect(spawned[1].pty.written).toEqual(['x'])

    // B 关掉自己的 t1,A 的还活着
    await table[CH.termKill](b.ctx, { termId: 't1' })
    expect(spawned[1].pty.killed).toBe(true)
    expect(spawned[0].pty.killed).toBe(false)
  })

  it('★连接断了 → 那个客户端开的 pty 全部收掉(否则服务器上攒下一堆不会退出的 shell)', async () => {
    const { svc, table, spawned } = harness()
    const a = client('remote-1')
    const b = client('remote-2')

    await table[CH.termCreate](a.ctx, { termId: 't1', cols: 80, rows: 24 })
    await table[CH.termCreate](a.ctx, { termId: 't2', cols: 80, rows: 24 })
    await table[CH.termCreate](b.ctx, { termId: 't1', cols: 80, rows: 24 })
    expect(svc.size()).toBe(3)

    a.disconnect()

    expect(spawned[0].pty.killed).toBe(true)
    expect(spawned[1].pty.killed).toBe(true)
    expect(spawned[2].pty.killed).toBe(false)     // B 还连着,不受影响
    expect(svc.size()).toBe(1)
  })

  it('一条连接只登记一次清理 —— 开 10 个终端不该压进去 10 个回调', async () => {
    const { table } = harness()
    const a = client('remote-1')
    for (let i = 0; i < 10; i++) await table[CH.termCreate](a.ctx, { termId: `t${i}`, cols: 80, rows: 24 })
    expect(a.closerCount()).toBe(1)
  })

  it('本机窗口不提供 onClose,照样开得起来(它活到进程退出为止)', async () => {
    const { svc, table } = harness()
    const local: InvokeCtx = { emit: () => {}, client: { id: 'local', label: '本机' } }
    expect(await table[CH.termCreate](local, { termId: 't1', cols: 80, rows: 24 })).toEqual({ ok: true })
    expect(svc.size()).toBe(1)
    svc.killOwner('local')
    expect(svc.size()).toBe(0)
  })

  it('同一个客户端拿同一个 id 再开一次 → 旧的先收掉,不留孤儿', async () => {
    const { svc, table, spawned } = harness()
    const a = client('remote-1')
    await table[CH.termCreate](a.ctx, { termId: 't1', cols: 80, rows: 24 })
    await table[CH.termCreate](a.ctx, { termId: 't1', cols: 80, rows: 24 })
    expect(spawned[0].pty.killed).toBe(true)
    expect(svc.size()).toBe(1)
  })

  it('每个客户端各有自己的上限,不会被别人占满', async () => {
    const { table } = harness()
    const a = client('remote-1')
    const b = client('remote-2')
    for (let i = 0; i < 12; i++) {
      expect(await table[CH.termCreate](a.ctx, { termId: `t${i}`, cols: 80, rows: 24 })).toEqual({ ok: true })
    }
    const over = await table[CH.termCreate](a.ctx, { termId: 't99', cols: 80, rows: 24 }) as { ok: false; error: string }
    expect(over.ok).toBe(false)
    expect(over.error).toContain('上限')
    // B 一个都没开过,不该被 A 拖累
    expect(await table[CH.termCreate](b.ctx, { termId: 't0', cols: 80, rows: 24 })).toEqual({ ok: true })
  })

  it('cwd:给的存在就用给的;不存在就落 fallback;fallback 也不行才落 home', async () => {
    const spawned: string[] = []
    const mk = (exists: (p: string) => boolean, fallbackCwd?: () => string | null) => {
      const svc = createTerminalService({
        spawn: (_s, _a, o) => { spawned.push(o.cwd); return fakePty() },
        exists, home: '/home/me', fallbackCwd, schedule: (cb) => cb(),
      })
      const t: MethodTable = {}; svc.register(t); return t
    }
    const local: InvokeCtx = { emit: () => {} }

    await mk(() => true)[CH.termCreate](local, { termId: 'a', cwd: '/w', cols: 80, rows: 24 })
    await mk((p) => p === '/ws', () => '/ws')[CH.termCreate](local, { termId: 'b', cwd: '/gone', cols: 80, rows: 24 })
    await mk(() => false, () => '/ws')[CH.termCreate](local, { termId: 'c', cwd: '/gone', cols: 80, rows: 24 })
    expect(spawned).toEqual(['/w', '/ws', '/home/me'])
  })

  it('OSC7 改了目录 → 只在**变化时**回一条 cwd,而且路径按 home 缩写', async () => {
    const { table, spawned } = harness()
    const a = client('remote-1')
    await table[CH.termCreate](a.ctx, { termId: 't1', cols: 80, rows: 24 })
    // ESC ] 7 ; file://<host><path> BEL。★用 \u 转义写,别把裸控制字符塞进源码 ——
    //  它们在编辑器和 diff 里都是隐形的。
    const osc = (p: string) => `\u001b]7;file://host${p}\u0007`
    spawned[0].pty._data(osc('/home/me/code'))
    spawned[0].pty._data(osc('/home/me/code'))   // 没变:不该再回一条
    spawned[0].pty._data(osc('/tmp'))
    expect(a.of(CH.termCwd).map(g => g.payload.cwd)).toEqual(['~/code', '/tmp'])
  })

  it('pty 自己退出 → 先把缓冲里剩下的输出发完,再报退出', async () => {
    // ★顺序不能反,也不能漏。漏了的话最后一条命令的输出永远看不到 —— 而那通常正是你要看的
    //  那几行(报错信息就在退出前)。这里**故意不让合批器自己 flush**(schedule 空实现),
    //  模拟「字节还压在缓冲里,进程就退了」。
    let pty!: ReturnType<typeof fakePty>
    const svc = createTerminalService({
      spawn: () => (pty = fakePty()), exists: () => true, schedule: () => {},
    })
    const table: MethodTable = {}
    svc.register(table)
    const a = client('remote-1')
    await table[CH.termCreate](a.ctx, { termId: 't1', cols: 80, rows: 24 })
    pty._data('最后一行:测试挂了')
    expect(a.got).toEqual([])                     // 还压在缓冲里
    pty._exit({ exitCode: 3 })
    expect(a.got.map(g => g.channel)).toEqual([CH.termData, CH.termExit])
    expect(a.got[0].payload).toEqual({ termId: 't1', data: '最后一行:测试挂了' })
    expect(a.got[1].payload).toMatchObject({ termId: 't1', exitCode: 3 })
  })

  it('node-pty 装不上时,报的是一句人看得懂的话,而不是 Cannot find module', async () => {
    // Linux 上这条是会真的发生的(没有覆盖所有 ABI 的预编译包)。
    const svc = createTerminalService({
      spawn: () => { throw new Error('这台主机上的终端组件(node-pty)没装好,开不了终端:boom') },
      exists: () => true,
    })
    const t: MethodTable = {}; svc.register(t)
    const r = await t[CH.termCreate]({ emit: () => {} }, { termId: 't1', cols: 80, rows: 24 }) as { ok: false; error: string }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('node-pty')
    expect(svc.size()).toBe(0)      // 失败不留半截状态
  })

  it('重复注册同一个 channel 直接抛 —— 和 registerIpc 里那个 on() 一致', () => {
    const { table } = harness()
    const svc2 = createTerminalService({ spawn: () => fakePty() })
    expect(() => svc2.register(table)).toThrow(/duplicate/)
  })

  it('出口坏掉(窗口关了)不该炸掉这一轮 flush', () => {
    const { table, spawned } = harness()
    const boom: InvokeCtx = { emit: () => { throw new Error('window closed') }, client: { id: 'remote-9', label: 'x' } }
    void table[CH.termCreate](boom, { termId: 't1', cols: 80, rows: 24 })
    expect(() => spawned[0].pty._data('x')).not.toThrow()
  })
})

describe('终端服务 · 变异检查', () => {
  it('如果内部键不带调用方,第二个客户端就会顶掉第一个 —— 这条证明那个 bug 是被挡住的', async () => {
    const { table, spawned } = harness()
    const a = client('remote-1')
    const b = client('remote-2')
    await table[CH.termCreate](a.ctx, { termId: 'same', cols: 80, rows: 24 })
    await table[CH.termCreate](b.ctx, { termId: 'same', cols: 80, rows: 24 })
    // 把 keyOf 改成 `(_, id) => id`,下面这句立刻变红(A 的 pty 会被 destroy 掉)
    expect(spawned.filter(s => !s.pty.killed)).toHaveLength(2)
  })

  it('如果输出走广播而不是 ctx.emit,别人的终端就会出现在你屏幕上', async () => {
    const { table, spawned } = harness()
    const a = client('remote-1')
    const b = client('remote-2')
    await table[CH.termCreate](a.ctx, { termId: 't1', cols: 80, rows: 24 })
    await table[CH.termCreate](b.ctx, { termId: 't2', cols: 80, rows: 24 })
    spawned[0].pty._data('机密')
    expect(b.got).toEqual([])
  })
})

describe('终端服务 · 和真表接在一起', () => {
  it('registerIpc 出来的表里就有 term:*(不是宿主各自注册的)', async () => {
    vi.resetModules()
    vi.doMock('electron', () => ({ dialog: {}, shell: {}, app: { getVersion: () => '0', getPath: () => '/tmp' } }))
    vi.doMock('../update/githubSource', () => ({
      fetchLatestRelease: async () => ({ version: '2.4.0', notes: 'n', assetUrl: 'u', assetSize: 6, assetName: 'a.dmg' }),
    }))
    const { registerIpc } = await import('../ipc/handlers')
    const { fakeHost } = await import('../host/fakeHost')
    const table = registerIpc(() => {}, {}, fakeHost())
    for (const ch of [CH.termCreate, CH.termWrite, CH.termResize, CH.termKill]) {
      expect(Object.keys(table)).toContain(ch)
    }
  })
})
