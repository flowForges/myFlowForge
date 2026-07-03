export interface FsWatcherLike {
  on(event: string, cb: (path: string) => void): FsWatcherLike
  close(): Promise<void>
}
export type WatchFn = (path: string, opts: unknown) => FsWatcherLike

// Manages a single live worktree watcher. Starting a new watch disposes the previous one,
// so only the selected project's worktree is ever watched (no cross-project confusion).
export class WorktreeWatcher {
  private current: FsWatcherLike | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(private watchFn: WatchFn, private debounceMs = 150) {}

  start(cwd: string, onChange: () => void): void {
    this.stop()
    // Ignore .git / node_modules and Forge's own per-workspace state dir. .forge holds the live
    // run unix socket (forge.sock); fs.watch on a socket throws UNKNOWN → unhandled rejection, so
    // the dir must never be descended into (it's internal state, not user source, anyway).
    const w = this.watchFn(cwd, { ignored: /(^|[/\\])(\.git|node_modules|\.forge)([/\\]|$)/, ignoreInitial: true })
    const fire = () => {
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(onChange, this.debounceMs)
    }
    w.on('add', fire).on('change', fire).on('unlink', fire)
    this.current = w
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.current) { void this.current.close(); this.current = null }
  }
}
