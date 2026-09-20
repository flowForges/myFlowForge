import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { CH } from '../ipc/channels'
import type { InvokeCtx, MethodTable } from '../ipc/invokeCtx'
import { TerminalManager, type PtyLike } from './terminalManager'
import { TermBatcher } from './termBatch'
import { makeCwdProbe } from './cwdProbe'
import { abbreviateHome, parseOsc7 } from './cwdTrack'

/**
 * 终端(PTY)作为**方法表里的一项**。
 *
 * ★★为什么要有这个文件:在此之前 `term:*` 是 `src/main/index.ts` 里直接 `ipcMain.handle` 注册的,
 *  **没进方法表** —— 于是「连上远程主机」时,终端面板里开出来的是**你面前这台**的 shell,
 *  不是你连的那台。界面上当时挂了一句「本机 · 非 XX」如实说明,但功能等于没有:
 *  连着 Linux daemon 想跑一下测试、看一眼 `git diff`,做不到。
 *  搬进方法表之后,它和会话、工作区、git 走同一条路 —— **shell 长在 host 上,界面长在客户端上**。
 *
 * 三件事是这一层特有的,别的方法都没有:
 *
 * 1. **按调用方隔离**。termId 是客户端自己编的(`term-1`、`term-2`),两台客户端连同一台 host
 *    必然撞号。所以内部键是 `owner::termId`,而发回去的事件仍用客户端自己那个 id ——
 *    客户端一个字都不用改,也永远看不到别人的终端。★不要「信任客户端会编唯一 id」:
 *    老版本客户端就不会,而代价是**你的终端被别人的连接顶掉**。
 * 2. **输出只回给开它的那个人**,走 `ctx.emit` 而不是广播。终端输出是这条链路上最吵的一路
 *    (一次 build 几万个 chunk);广播出去等于让每台连着的手机白收一遍,而手机上根本没有终端。
 * 3. **连接断了要把 pty 收掉**(`ctx.onClose`)。这是唯一握着操作系统资源的方法,
 *    详见 `InvokeCtx.onClose` 上那段。
 */

export type TerminalSpawn = (
  shell: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number },
) => PtyLike

export type TerminalDeps = {
  /** 不给就在**第一次开终端时**懒加载 node-pty(原生模块,加载失败不该拖垮整个进程/测试) */
  spawn?: TerminalSpawn
  exists?: (p: string) => boolean
  home?: string
  /** 探当前目录用。默认 `lsof`;探不到就静默放弃(OSC7 是主路径,这条只是兜底) */
  exec?: (pid: number) => Promise<string>
  /** 合批窗口的调度器,测试注入以求确定性 */
  schedule?: (cb: () => void) => void
  /** 性能埋点。Electron 那边接的是 perfSpan,daemon 不接 */
  span?: <T>(name: string, fn: () => T) => T
  /** 没给 cwd 时的落脚点(Electron 侧 = 当前工作区)。不存在就落 home */
  fallbackCwd?: () => string | null | undefined
  /** 单个调用方最多开几个 */
  capPerOwner?: number
}

export type TermCreateOpts = { termId: string; cwd?: string; cols: number; rows: number }
export type TermCreateResult = { ok: true } | { ok: false; error: string }

export interface TerminalService {
  /** 把 term:* 挂进方法表。重复注册直接抛 —— 和 registerIpc 里那个 `on` 一致。 */
  register(table: MethodTable): void
  /** 某个调用方走了(连接断了 / 主动踢掉):把它开的终端全关掉。 */
  killOwner(owner: string): void
  killAll(): void
  /** 现在活着几个 pty(测试和诊断用) */
  size(): number
}

const LOCAL = 'local'
/**
 * 内部键的分隔符。★**故意用两个看得见的字符**,不用 NUL —— 这个仓库已经栽过一次:
 * `unread.ts` 的分隔符是真 NUL,在终端里显示成一个空格,骗过了两个人。
 * 调用方 id 由 `serveConnection` 生成(`local` / `remote-N`),永远不含 `::`,
 * 所以按**第一个** `::` 切一定切在对的位置,哪怕客户端编的 termId 里自己带了 `::`。
 */
const SEP = '::'
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function createTerminalService(deps: TerminalDeps = {}): TerminalService {
  const home = deps.home ?? homedir()
  const exists = deps.exists ?? existsSync
  const capPerOwner = deps.capPerOwner ?? 12
  const exec = deps.exec ?? ((pid: number) => new Promise<string>((res, rej) =>
    execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], (e, out) => (e ? rej(e) : res(out)))))
  const span = deps.span ?? (<T,>(_n: string, fn: () => T) => fn())

  /** 内部键 → 发起方 / 出口 / cwd 探针。全部按 `owner::termId` 索引。 */
  const owners = new Map<string, string>()
  const sinks = new Map<string, (channel: string, payload: unknown) => void>()
  const cwdProbes = new Map<string, (pid: number) => Promise<void>>()
  const cwdTimers = new Map<string, NodeJS.Timeout>()
  const lastOscCwd = new Map<string, string>()
  /** 已经登记过 onClose 的调用方 —— 一条连接登记一次就够,不必每开一个终端登记一次。 */
  const hooked = new Set<string>()

  const keyOf = (owner: string, termId: string) => `${owner}${SEP}${termId}`
  const termIdOf = (key: string) => key.slice(key.indexOf(SEP) + SEP.length)

  let spawn = deps.spawn
  const lazySpawn: TerminalSpawn = (shell, args, o) => {
    if (!spawn) {
      let nodePty: typeof import('node-pty')
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        nodePty = require('node-pty') as typeof import('node-pty')
      } catch (e) {
        // ★这条在 Linux 上是**会真的发生**的:node-pty 没有覆盖所有 ABI 的预编译包,
        //  服务器上少了 python3/make/g++ 就编不出来。说清是哪儿的问题,别只报一句
        //  「Cannot find module」—— 那句话会把人引到「是不是 app 装坏了」上去。
        throw new Error(`这台主机上的终端组件(node-pty)没装好,开不了终端:${errText(e)}`)
      }
      spawn = (sh, a, opt) => nodePty.spawn(sh, a, {
        name: 'xterm-256color',
        cwd: opt.cwd,
        env: opt.env as Record<string, string>,
        cols: opt.cols,
        rows: opt.rows,
      })
    }
    return spawn(shell, args, o)
  }

  const emit = (key: string, channel: string, payload: Record<string, unknown>) => {
    // 出口随时可能不在了(窗口关了、连接断了)。两个宿主的 emit 各自吞了异常,这里再兜一层:
    // 一个终端的出口坏掉不该炸掉合批器里其余终端那一轮 flush。
    try { sinks.get(key)?.(channel, { termId: termIdOf(key), ...payload }) } catch { /* 出口已关 */ }
  }

  let batcher: TermBatcher
  const mgr = new TerminalManager({
    spawn: (shell, args, o) => lazySpawn(shell, args, o),
    onData: (key, data) => batcher.push(key, data),
    onExit: (key, e) => {
      batcher.flush(key)          // 先把缓冲里最后那点输出发出去,再报退出
      forget(key)
      emit(key, CH.termExit, { ...e })
      sinks.delete(key)
      owners.delete(key)
    },
    exists,
    // 单人上限在下面按 owner 算;这里是整台机器的绝对天花板,防一个跑飞的客户端把 host 开满。
    cap: 64,
  })

  const scheduleCwd = (key: string) => {
    const probe = cwdProbes.get(key)
    const pid = mgr.pidOf(key)
    if (!probe || pid === undefined) return
    clearTimeout(cwdTimers.get(key))
    cwdTimers.set(key, setTimeout(() => void probe(pid), 150))
  }

  batcher = new TermBatcher({
    schedule: deps.schedule,
    flush: (key, data) => span('flush', () => {
      emit(key, CH.termData, { data })
      const osc = parseOsc7(data)
      if (osc) {
        const abbr = abbreviateHome(osc, home)
        if (abbr !== lastOscCwd.get(key)) { lastOscCwd.set(key, abbr); emit(key, CH.termCwd, { cwd: abbr }) }
      } else {
        scheduleCwd(key)
      }
    }),
  })

  /** 丢掉一个终端的**附属状态**(探针/定时器/缓冲),不动 pty 本身。 */
  const forget = (key: string) => {
    cwdProbes.delete(key)
    const t = cwdTimers.get(key)
    if (t !== undefined) { clearTimeout(t); cwdTimers.delete(key) }
    lastOscCwd.delete(key)
  }

  const destroy = (key: string) => {
    forget(key)
    batcher.drop(key)
    sinks.delete(key)
    owners.delete(key)
    mgr.kill(key)               // onExit 不会因 kill 而必然回调,所以上面几行不能只写在 onExit 里
  }

  const ownerKeys = (owner: string) => [...owners.entries()].filter(([, o]) => o === owner).map(([k]) => k)

  const killOwner = (owner: string) => {
    for (const k of ownerKeys(owner)) destroy(k)
    hooked.delete(owner)
  }

  const create = (ctx: InvokeCtx, opts: TermCreateOpts): TermCreateResult => {
    const owner = ctx.client?.id ?? LOCAL
    const key = keyOf(owner, opts.termId)
    try {
      // 同一个调用方拿同一个 id 再开一次(重连后重用了 id):先把旧的收掉,否则旧 pty 变孤儿。
      // ★因为键里带 owner,这里**不可能**误伤别人那个同名终端。
      if (mgr.has(key)) destroy(key)
      if (ownerKeys(owner).length >= capPerOwner) throw new Error(`终端数量已达上限(${capPerOwner} 个)`)

      const wanted = opts.cwd && exists(opts.cwd) ? opts.cwd : undefined
      const fallback = deps.fallbackCwd?.()
      const cwd = wanted ?? (fallback && exists(fallback) ? fallback : home)

      // 出口和归属要在 create **之前**登记好:pty 一起来就可能立刻吐字节(shell 的第一行提示符),
      // 那时 onData 已经在跑了,登记晚一步就会把开头那几行丢掉。
      sinks.set(key, ctx.emit)
      owners.set(key, owner)
      mgr.create({ termId: key, cwd, cols: opts.cols || 80, rows: opts.rows || 24 })
      cwdProbes.set(key, makeCwdProbe({ exec, home, onCwd: (c) => emit(key, CH.termCwd, { cwd: c }) }))
      scheduleCwd(key)

      // 一条连接登记一次。本机窗口不提供 onClose(它活到进程退出),所以这里天然只对远程生效。
      if (ctx.onClose && !hooked.has(owner)) {
        hooked.add(owner)
        ctx.onClose(() => killOwner(owner))
      }
      return { ok: true }
    } catch (e) {
      destroy(key)
      // `TERM_CAP` 是 TerminalManager 那道整机天花板抛的裸标识。它会**原样显示在标签页上**
      // (渲染层直接印 `t.error`),所以在这儿翻成人话 —— 六个客户端各开满才碰得到,
      // 但真碰到时「TERM_CAP」这四个字对用户毫无信息量。
      const msg = errText(e)
      return { ok: false, error: msg === 'TERM_CAP' ? '这台主机上的终端已经开满了' : msg }
    }
  }

  return {
    register(table: MethodTable) {
      const put = (ch: string, fn: (ctx: InvokeCtx, ...args: any[]) => unknown) => {
        if (table[ch]) throw new Error(`duplicate ipc channel: ${ch}`)
        table[ch] = fn as MethodTable[string]
      }
      const own = (ctx: InvokeCtx, termId: string) => keyOf(ctx.client?.id ?? LOCAL, termId)
      put(CH.termCreate, (ctx, o: TermCreateOpts) => create(ctx, o))
      // 写/改大小/关:**没有返回值也要是 invoke**。老写法是 `ipcMain.on`(单向),而单向的消息
      // 压根不经过路由器 —— 那正是「连着远程却写进了本机 shell」的另一半原因。
      put(CH.termWrite, (ctx, p: { termId: string; data: string }) => { mgr.write(own(ctx, p.termId), p.data) })
      put(CH.termResize, (ctx, p: { termId: string; cols: number; rows: number }) => { mgr.resize(own(ctx, p.termId), p.cols, p.rows) })
      put(CH.termKill, (ctx, p: { termId: string }) => { destroy(own(ctx, p.termId)) })
    },
    killOwner,
    killAll() {
      for (const k of [...owners.keys()]) forget(k)
      owners.clear(); sinks.clear(); hooked.clear()
      mgr.killAll()
    },
    size: () => mgr.size(),
  }
}
