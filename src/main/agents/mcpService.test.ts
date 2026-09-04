import { describe, it, expect, vi } from 'vitest'
import { McpService, type McpDeps } from './mcpService'
import type { PtyLike } from '../terminal/terminalManager'

/**
 * 授权那条路**只能在 pty 里跑**(实测:普通管道 stdin 会被 CLI 直接拒),所以这里给一个假 pty,
 * 把真 CLI 的输出**逐段**喂进去 —— 一次性喂完等于绕开了「分片到达」这个最容易出错的地方。
 */
class FakePty implements PtyLike {
  pid = 4242
  written: string[] = []
  killed = false
  private dataCb: (d: string) => void = () => {}
  private exitCb: (e: { exitCode: number }) => void = () => {}
  onData(cb: (d: string) => void) { this.dataCb = cb }
  onExit(cb: (e: { exitCode: number }) => void) { this.exitCb = cb }
  write(d: string) { this.written.push(d) }
  resize() {}
  kill() { this.killed = true }
  emit(d: string) { this.dataCb(d) }
  exit(code = 0) { this.exitCb({ exitCode: code }) }
}

const ESC = '\u001b'
const BEL = '\u0007'
const URL = 'https://mcp.sentry.dev/oauth/authorize?client_id=abc'
const URL_CHUNK = `Visit this URL to authorize:\n\n  ${ESC}]8;;${URL}${BEL}${ESC}[94m${URL}${ESC}[39m${ESC}]8;;${BEL}\n\n`
const PASTE_CHUNK = `Waiting for authorization… (^C to cancel)\n${ESC}[1G${ESC}[0JOr paste the redirect URL here: `

const CLAUDE_MCP_HELP = `Commands:
  list      List configured MCP servers.
  login [options] <name>   Authenticate with an MCP server
  logout <name>            Clear stored OAuth credentials`
const CLAUDE_LOGIN_HELP = `Options:
  --no-browser  Print the authorization URL instead of opening a browser`

/**
 * ★等到 `loginStart` 真的把 pty spawn 出来。
 *  它前面有两个 await(找可执行文件、探能力),`await Promise.resolve()` 只推进一个微任务 ——
 *  在那之前 emit,数据是喂给一个**还没挂上监听的** pty,测试会红在一个根本不存在的 bug 上。
 */
const tick = () => new Promise((r) => setTimeout(r, 0))

function make(over: Partial<McpDeps> = {}) {
  const pty = new FakePty()
  const runs: string[][] = []
  const deps: McpDeps = {
    binFor: async () => '/usr/local/bin/claude',
    envFor: () => ({ PATH: '/usr/bin' }),
    run: async (_bin, args) => {
      runs.push(args)
      if (args[1] === '--help') return { stdout: CLAUDE_MCP_HELP, code: 0 }
      if (args[1] === 'login') return { stdout: CLAUDE_LOGIN_HELP, code: 0 }
      if (args[1] === 'list') return { stdout: 'a: https://a/mcp - ! Needs authentication', code: 0 }
      return { stdout: '', code: 0 }
    },
    spawnPty: () => pty,
    ...over,
  }
  return { svc: new McpService(deps), pty, runs, deps }
}

describe('capsFor', () => {
  it('探子命令,再单独探两个子命令自己的开关', async () => {
    const { svc, runs } = make()
    const caps = await svc.capsFor('claude')
    expect(caps).toMatchObject({ list: true, login: true, logout: true, noBrowser: true })
    expect(runs).toEqual([['mcp', '--help'], ['mcp', 'list', '--help'], ['mcp', 'login', '--help']])
  })
  it('★★--json 只写在 `mcp list --help` 里,顶层 help 看不到 —— 少探这一次,codex 的列表会全空', async () => {
    // 这是 2026-09-05 真 CLI 冒烟测试照出来的:codex 顶层 `mcp --help` 里没有 --json,
    // 判成"没有"之后列表退回文本解析,而它的表格根本不是那个格式 ⇒ 面板上一台都不显示。
    const { svc } = make({
      run: async (_b, args) => {
        if (args[1] === '--help') return { stdout: 'Commands:\n  list\n  login\n', code: 0 }
        if (args[1] === 'list') return { stdout: 'Options:\n      --json\n          Output as JSON', code: 0 }
        return { stdout: 'Options:\n  --scopes', code: 0 }
      },
    })
    expect((await svc.capsFor('codex')).json).toBe(true)
  })
  it('★同一个 bin 只探一次(每开一次面板都探 = 每次都多等几个进程)', async () => {
    const { svc, runs } = make()
    await svc.capsFor('claude')
    await svc.capsFor('claude')
    expect(runs.length).toBe(3)
  })
  it('没装 → 什么都不支持,而不是抛', async () => {
    const { svc } = make({ binFor: async () => null })
    expect(await svc.capsFor('nope')).toMatchObject({ mcp: false, login: false })
  })
  it('★help 拿不到(进程直接炸)也不能把整个面板带崩', async () => {
    const { svc } = make({ run: async () => { throw new Error('ENOENT') } })
    expect(await svc.capsFor('claude')).toMatchObject({ mcp: false })
  })
})

describe('list', () => {
  it('没有 --json 的走文本解析', async () => {
    const { svc, runs } = make()
    const out = await svc.list('claude', '/ws')
    expect(out).toEqual([{ name: 'a', target: 'https://a/mcp', auth: 'needs-auth', detail: '! Needs authentication' }])
    expect(runs.at(-1)).toEqual(['mcp', 'list'])
  })

  it('有 --json 的走 JSON', async () => {
    const seen: string[][] = []
    const { svc } = make({
      run: async (_b, args) => {
        seen.push(args)
        if (args[1] === '--help') return { stdout: 'Commands:\n  list\n  login\n      --json  json out', code: 0 }
        if (args[2] === '--help') return { stdout: 'Options:\n  --scopes', code: 0 }
        return { stdout: JSON.stringify([{ name: 'x', enabled: true, transport: { type: 'streamable_http', url: 'https://x/mcp' }, auth_status: 'not_logged_in' }]), code: 0 }
      },
    })
    expect(await svc.list('codex', '/ws')).toEqual([
      { name: 'x', target: 'https://x/mcp', auth: 'needs-auth', detail: 'not_logged_in' },
    ])
    expect(seen.at(-1)).toEqual(['mcp', 'list', '--json'])
  })

  it('★JSON 形状对不上时退回文本解析 —— 显示成「一台都没有」会让人跑去重配一遍', async () => {
    const { svc } = make({
      run: async (_b, args) => {
        if (args[1] === '--help') return { stdout: 'Commands:\n  list\n      --json  json out', code: 0 }
        return { stdout: 'weird: https://w/mcp - ✔ Connected', code: 0 }
      },
    })
    expect(await svc.list('weird', '/ws')).toEqual([
      { name: 'weird', target: 'https://w/mcp', auth: 'connected', detail: '✔ Connected' },
    ])
  })

  it('★真的一台都没有时,别把空数组也当成「没看懂」再解析一遍', async () => {
    const { svc } = make({
      run: async (_b, args) => {
        if (args[1] === '--help') return { stdout: 'Commands:\n  list\n      --json', code: 0 }
        return { stdout: '[]', code: 0 }
      },
    })
    expect(await svc.list('codex', '/ws')).toEqual([])
  })

  it('★命令在**工作区目录**里跑 —— 项目级(.mcp.json)的服务器只在那儿看得见', async () => {
    const cwds: string[] = []
    const { svc } = make({ run: async (_b, args, cwd) => { cwds.push(cwd); return { stdout: args[1] === '--help' ? CLAUDE_MCP_HELP : '', code: 0 } } })
    await svc.list('claude', '/ws/alpha')
    expect(cwds.at(-1)).toBe('/ws/alpha')
  })

  it('这个 CLI 没有 mcp list → 空,不抛', async () => {
    const { svc } = make({ run: async () => ({ stdout: 'unknown command', code: 1 }) })
    expect(await svc.list('cursor', '/ws')).toEqual([])
  })
})

describe('loginStart', () => {
  it('★等到授权地址才返回,并且从 pty 的转义壳里剥出完整地址', async () => {
    const { svc, pty } = make()
    const p = svc.loginStart('claude', '/ws', 'sentry')
    await tick()
    pty.emit('Starting authentication for "sentry"…\n')
    pty.emit(URL_CHUNK)
    const r = await p
    expect(r.url).toBe(URL)
    expect(r.outcome).toBeNull()
  })

  it('★地址是**分片**到达的(pty 就是这样),拼起来再认', async () => {
    const { svc, pty } = make()
    const p = svc.loginStart('claude', '/ws', 'sentry')
    await tick()
    const half = Math.floor(URL_CHUNK.length / 2)
    pty.emit(URL_CHUNK.slice(0, half))
    pty.emit(URL_CHUNK.slice(half))
    expect((await p).url).toBe(URL)
  })

  it('带 --no-browser(CLI 支持时);不支持就不带', async () => {
    // ★每一路都要把那个 pty **收尾**(emit 出结果),否则 loginStart 会真的挂 30 秒等地址 ——
    //  测试本身早就断言完了,进程却还吊着一个定时器,整份文件跟着变慢。
    const seen: string[][] = []
    const ptys: FakePty[] = []
    const { svc } = make({ spawnPty: (_b, args) => { seen.push(args); const p = new FakePty(); ptys.push(p); return p as PtyLike } })
    const a = svc.loginStart('claude', '/ws', 'sentry')
    await new Promise((r) => setTimeout(r, 0))
    expect(seen[0]).toEqual(['mcp', 'login', 'sentry', '--no-browser'])
    ptys[0].exit(0)
    await a

    const seen2: string[][] = []
    const ptys2: FakePty[] = []
    const { svc: s2 } = make({
      run: async (_b, args) => ({ stdout: args[1] === '--help' ? 'Commands:\n  login\n' : 'Options:\n  --scopes', code: 0 }),
      spawnPty: (_b, args) => { seen2.push(args); const p = new FakePty(); ptys2.push(p); return p as PtyLike },
    })
    const b = s2.loginStart('codex', '/ws', 'sentry')
    await new Promise((r) => setTimeout(r, 0))
    expect(seen2[0]).toEqual(['mcp', 'login', 'sentry'])
    ptys2[0].exit(0)
    await b
  })

  it('★进程没吭一声就退了 → 按失败给结论,不能让界面一直转圈', async () => {
    const { svc, pty } = make()
    const p = svc.loginStart('claude', '/ws', 'sentry')
    await tick()
    pty.exit(1)
    expect((await p).outcome).toBe('fail')
  })

  it('还没等到地址就先失败了(真实原话:stdin 不是终端)', async () => {
    const { svc, pty } = make()
    const p = svc.loginStart('claude', '/ws', 'sentry')
    await tick()
    pty.emit(`Couldn't complete authentication for "sentry": stdin isn't a terminal\n`)
    const r = await p
    expect(r.outcome).toBe('fail')
    expect(r.url).toBeNull()
  })

  it('没装 / 不支持 login 时明确报错', async () => {
    await expect(make({ binFor: async () => null }).svc.loginStart('x', '/ws', 'n')).rejects.toThrow('可执行文件')
    const { svc } = make({ run: async () => ({ stdout: 'Commands:\n  list\n', code: 0 }) })
    await expect(svc.loginStart('x', '/ws', 'n')).rejects.toThrow('mcp login')
  })
})

describe('paste / waitResult / cancel', () => {
  it('★粘回去的地址后面要带回车 —— 不带的话 CLI 那一行永远读不完', async () => {
    const { svc, pty } = make()
    const started = svc.loginStart('claude', '/ws', 'sentry')
    await tick()
    pty.emit(URL_CHUNK + PASTE_CHUNK)
    const { id, needsPaste } = await started
    expect(needsPaste).toBe(true)
    const done = svc.paste(id, '  http://localhost:3118/callback?code=xyz  ')
    await tick()
    pty.emit('\nAuthentication successful\n')
    expect((await done).outcome).toBe('ok')
    expect(pty.written).toEqual(['http://localhost:3118/callback?code=xyz\r'])
  })

  it('客户端就是主机时,localhost 回调自己完成 —— 不用粘', async () => {
    const { svc, pty } = make()
    const started = svc.loginStart('claude', '/ws', 'sentry')
    await tick()
    pty.emit(URL_CHUNK)
    const { id } = await started
    const w = svc.waitResult(id, 5000)
    await tick()
    pty.emit('\nAuthentication successful\n')
    expect((await w).outcome).toBe('ok')
  })

  it('★取消要真把进程杀掉:mcp login 会一直挂着等回调,不杀就是个常驻孤儿', async () => {
    const { svc, pty } = make()
    const started = svc.loginStart('claude', '/ws', 'sentry')
    await tick()
    pty.emit(URL_CHUNK)
    const { id } = await started
    svc.cancel(id)
    expect(pty.killed).toBe(true)
  })

  it('会话已经结束了再粘 → 明确说清楚,而不是静默无事发生', async () => {
    const { svc } = make()
    await expect(svc.paste('mcp-999', 'http://x')).rejects.toThrow('重新点一次')
  })

  it('disposeAll 把挂着的都杀了', async () => {
    const ptys: FakePty[] = []
    const { svc } = make({ spawnPty: () => { const p = new FakePty(); ptys.push(p); return p as PtyLike } })
    const a = svc.loginStart('claude', '/ws', 'one')
    await tick()
    ptys[0].emit(URL_CHUNK)
    await a
    svc.disposeAll()
    expect(ptys[0].killed).toBe(true)
  })
})

describe('logout', () => {
  it('调 mcp logout,并且在工作区目录里跑', async () => {
    const calls: [string[], string][] = []
    const { svc } = make({
      run: async (_b, args, cwd) => { calls.push([args, cwd]); return { stdout: args[1] === '--help' ? CLAUDE_MCP_HELP : args[1] === 'login' ? CLAUDE_LOGIN_HELP : 'done', code: 0 } },
    })
    await svc.logout('claude', '/ws/alpha', 'sentry')
    expect(calls.at(-1)).toEqual([['mcp', 'logout', 'sentry'], '/ws/alpha'])
  })
  it('CLI 没有 logout 就明说', async () => {
    const { svc } = make({ run: async () => ({ stdout: 'Commands:\n  list\n', code: 0 }) })
    await expect(svc.logout('x', '/ws', 'n')).rejects.toThrow('mcp logout')
  })
})

describe('超时', () => {
  it('★等不到地址也要返回,把已经收到的那半截输出交出去 —— 不能挂死', async () => {
    vi.useFakeTimers()
    try {
      const { svc, pty } = make()
      const p = svc.loginStart('claude', '/ws', 'sentry')
      await vi.advanceTimersByTimeAsync(0)   // 让 loginStart 走到 spawn
      pty.emit('Starting authentication…\n')
      await vi.advanceTimersByTimeAsync(31_000)
      const r = await p
      expect(r.url).toBeNull()
      expect(r.text).toContain('Starting authentication')
    } finally {
      vi.useRealTimers()
    }
  })
})
