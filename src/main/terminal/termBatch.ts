// Coalesce high-frequency PTY output before it crosses the IPC boundary.
//
// node-pty emits many tiny chunks — every keystroke echo, every prompt redraw, and under a
// build/log flood thousands of chunks per second. Sending one `webContents.send` per chunk
// saturates the main event loop, which both janks heavy output AND delays keystroke echo (a lone
// keystroke's round-trip waits behind the flood). Batching collapses a burst into a single IPC
// message per short coalescing window; the latency added to an isolated keystroke is sub-frame and
// imperceptible, while a flood drops from thousands of IPC messages/sec to ~120.
export interface TermBatcherDeps {
  // Emit one coalesced blob for a terminal (wired to webContents.send + cwd tracking).
  flush: (termId: string, data: string) => void
  // Schedule `cb` after the coalescing window. Injectable so tests run deterministically.
  schedule?: (cb: () => void) => void
  // Flush a single terminal immediately once its pending buffer reaches this many bytes, so one
  // long-running command keeps streaming (bounded latency + memory) instead of buffering unbounded.
  maxBytes?: number
}

export class TermBatcher {
  private buf = new Map<string, string>()
  private pending = false
  private readonly schedule: (cb: () => void) => void
  private readonly maxBytes: number

  constructor(private deps: TermBatcherDeps) {
    this.schedule = deps.schedule ?? ((cb) => { setTimeout(cb, 8) })
    this.maxBytes = deps.maxBytes ?? 256 * 1024
  }

  // Buffer a chunk; flush now if this term crossed the size cap, else arm the coalescing timer.
  push(termId: string, data: string): void {
    const next = (this.buf.get(termId) ?? '') + data
    if (next.length >= this.maxBytes) {
      this.buf.delete(termId)
      this.deps.flush(termId, next)
      return
    }
    this.buf.set(termId, next)
    if (!this.pending) {
      this.pending = true
      this.schedule(() => this.flushAll())
    }
  }

  // Flush a single terminal's pending buffer now (e.g. on exit, so trailing output isn't lost).
  flush(termId: string): void {
    const d = this.buf.get(termId)
    if (d !== undefined) {
      this.buf.delete(termId)
      this.deps.flush(termId, d)
    }
  }

  private flushAll(): void {
    this.pending = false
    if (this.buf.size === 0) return
    // Snapshot then clear so a flush callback that re-enters push() starts a fresh window.
    const entries = [...this.buf]
    this.buf.clear()
    for (const [termId, d] of entries) this.deps.flush(termId, d)
  }

  // Discard a terminal's pending buffer without emitting (e.g. after it was killed).
  drop(termId: string): void { this.buf.delete(termId) }
}
