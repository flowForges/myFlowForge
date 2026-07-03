import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WorktreeWatcher } from './worktreeWatcher'

function makeFake() {
  const handlers: Record<string, ((p: string) => void)[]> = {}
  let closed = false
  const w = {
    on(ev: string, cb: (p: string) => void) { (handlers[ev] ||= []).push(cb); return w },
    close: vi.fn(async () => { closed = true }),
    emit(ev: string) { (handlers[ev] || []).forEach(cb => cb('x')) },
    get closed() { return closed }
  }
  return w
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('WorktreeWatcher', () => {
  it('debounces change events into a single onChange call', () => {
    const fake = makeFake()
    const watcher = new WorktreeWatcher(() => fake as any, 150)
    const onChange = vi.fn()
    watcher.start('/w', onChange)
    fake.emit('change'); fake.emit('add'); fake.emit('change')
    expect(onChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(150)
    expect(onChange).toHaveBeenCalledTimes(1)
  })
  it('stops the previous watcher when started again', () => {
    const a = makeFake(); const b = makeFake()
    const watchers = [a, b]; let i = 0
    const watcher = new WorktreeWatcher(() => watchers[i++] as any, 150)
    watcher.start('/w1', vi.fn())
    watcher.start('/w2', vi.fn())
    expect(a.close).toHaveBeenCalled()
  })
  it('ignores .forge internal state so chokidar never tries to watch the run unix socket', () => {
    let opts: any
    const watcher = new WorktreeWatcher((_p, o) => { opts = o; return makeFake() as any }, 150)
    watcher.start('/w', vi.fn())
    const ig = opts.ignored as RegExp
    // .forge holds runs/, chat.jsonl, and live unix sockets (forge.sock) — fs.watch on a socket
    // throws UNKNOWN, so the whole dir must be ignored (it's also not user source).
    expect(ig.test('/w/.forge/runs/run-x/forge.sock')).toBe(true)
    expect(ig.test('/w/.forge')).toBe(true)
    // existing ignores still hold
    expect(ig.test('/w/.git/HEAD')).toBe(true)
    expect(ig.test('/w/node_modules/x/index.js')).toBe(true)
    // real source is not ignored
    expect(ig.test('/w/src/index.ts')).toBe(false)
  })
})
