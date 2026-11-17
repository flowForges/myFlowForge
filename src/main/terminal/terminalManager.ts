import { existsSync } from 'node:fs'
import { resolveShell } from './resolveShell'

export interface PtyLike {
  onData(cb: (d: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  write(d: string): void
  resize(c: number, r: number): void
  kill(): void
  pid: number
}
export interface TermManagerDeps {
  spawn: (shell: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number }) => PtyLike
  onData: (termId: string, data: string) => void
  onExit: (termId: string, e: { exitCode: number; signal?: number }) => void
  env?: NodeJS.ProcessEnv
  exists?: (p: string) => boolean
  // 可注入,好让这个类在任何宿主上都能测(默认取真实平台)。第二期 daemon 也会用到:
  // 决定起哪个 shell 的是【host 的平台】,不是客户端的。
  platform?: NodeJS.Platform
  cap?: number
}

export class TerminalManager {
  private ptys = new Map<string, PtyLike>()
  private cap: number
  constructor(private deps: TermManagerDeps) { this.cap = deps.cap ?? 12 }

  create(opts: { termId: string; cwd: string; cols: number; rows: number }): void {
    if (this.ptys.size >= this.cap) throw new Error('TERM_CAP')
    const env = this.deps.env ?? process.env
    // Default to a REAL filesystem probe: resolveShell picks the first candidate that exists, so a
    // stub that always says yes would accept a shell that isn't installed (on Windows the pwsh 7
    // path is only present when PowerShell 7 was installed separately).
    const { shell, args } = resolveShell(env, this.deps.exists ?? existsSync, this.deps.platform)
    const platform = this.deps.platform ?? process.platform
    const ptyEnv: NodeJS.ProcessEnv = { ...env, ...utf8Fallback(env, platform), TERM: 'xterm-256color', COLORTERM: 'truecolor', FORGE_TERMINAL: '1' }
    const pty = this.deps.spawn(shell, args, { cwd: opts.cwd, env: ptyEnv, cols: opts.cols, rows: opts.rows })
    pty.onData(d => this.deps.onData(opts.termId, d))
    pty.onExit(e => { this.ptys.delete(opts.termId); this.deps.onExit(opts.termId, e) })
    this.ptys.set(opts.termId, pty)
  }
  write(termId: string, data: string): void { this.ptys.get(termId)?.write(data) }
  resize(termId: string, cols: number, rows: number): void { this.ptys.get(termId)?.resize(cols, rows) }
  kill(termId: string): void { const p = this.ptys.get(termId); if (p) { p.kill(); this.ptys.delete(termId) } }
  killAll(): void { for (const p of this.ptys.values()) p.kill(); this.ptys.clear() }
  has(termId: string): boolean { return this.ptys.has(termId) }
  pidOf(termId: string): number | undefined { return this.ptys.get(termId)?.pid }
  size(): number { return this.ptys.size }
}

/**
 * ★从 Finder / Dock 起的 app **没有** LANG / LC_*:那是 Terminal.app、iTerm 自己给 shell 补上的,
 * launchd 不给。于是我们开出来的 zsh 跑在 C locale 里 —— 🔥 按字节算 4 格、❯ 算 3 格,
 * 中文按字节显示成 `<0081>` 这种转义,行编辑整个错位。
 *
 * 只在**一个都没有**的时候补,而且只补 LC_CTYPE(字符集),不碰 LANG —— 那会连带改掉
 * git / man 等工具的提示语言。用户自己设过的(哪怕是明确的 `C`)一律原样保留。
 * macOS 上 `UTF-8` 本身就是合法的 LC_CTYPE;Linux 上没有这个名字,要用 `C.UTF-8`。
 */
function utf8Fallback(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  if (platform === 'win32') return {}
  if (env.LC_ALL || env.LC_CTYPE || env.LANG) return {}
  return { LC_CTYPE: platform === 'darwin' ? 'UTF-8' : 'C.UTF-8' }
}
