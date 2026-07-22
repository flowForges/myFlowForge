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
    // the dir must never be descended into (it's internal state, not user source, anyway). Also
    // skip other heavy build/dep dirs (dist/build/target/.venv/vendor/.next/coverage) and cap
    // recursion depth: if cwd ever ends up pointed at a giant multi-repo folder (e.g. a
    // workspace with no scoped project), an unbounded chokidar scan + fs.watch handle setup can
    // starve the main-process event loop and freeze the whole app. depth: 6 is deep enough for
    // any normal single-repo worktree.
    const w = this.watchFn(cwd, {
      ignored: /(^|[/\\])(\.git|node_modules|\.forge|dist|build|target|\.venv|vendor|\.next|coverage)([/\\]|$)/,
      ignoreInitial: true,
      depth: 6,
    })
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
