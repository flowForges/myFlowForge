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
  cap?: number
}

export class TerminalManager {
  private ptys = new Map<string, PtyLike>()
  private cap: number
  constructor(private deps: TermManagerDeps) { this.cap = deps.cap ?? 12 }

  create(opts: { termId: string; cwd: string; cols: number; rows: number }): void {
    if (this.ptys.size >= this.cap) throw new Error('TERM_CAP')
    const env = this.deps.env ?? process.env
    const { shell, args } = resolveShell(env, this.deps.exists ?? (() => true))
    const ptyEnv: NodeJS.ProcessEnv = { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', FORGE_TERMINAL: '1' }
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
