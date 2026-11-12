import type { Mod } from '@shared/computerUse'
import type {
  Button, CaptureOpts, CaptureResult, ComputerDriver, DisplaySig, DriverStatus, PostAction, PostGuard, PostResult,
  Pt, Rect, WinHit,
} from './driver'

const DISPLAY: DisplaySig = { id: 1, widthPt: 1792, heightPt: 1120, backing: 2 }
const inside = (r: Rect, p: Pt) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h

export type HitMap = ((p: Pt) => WinHit | null) | WinHit | null | { rect: Rect; hit: WinHit }[]

export interface FakeDriverScript {
  status?: Partial<DriverStatus>
  front?: WinHit | null
  hits?: HitMap
  idle?: number
  postResult?: PostResult
  apps?: { bundleId: string; name: string }[]
  capture?: Partial<CaptureResult>
  abort?: 'stopped' | 'killed'
}

/** In-memory driver for service/executor/handler tests. Never touches the screen. */
export function fakeDriver(script: FakeDriverScript = {}) {
  let status: DriverStatus = {
    osVersion: '14.5', osOK: true, screen: true, ax: true, locked: false, onConsole: true, asleep: false,
    secureInput: false, display: DISPLAY, disclaim: true, ...script.status,
  }
  let front: WinHit | null = script.front ?? null
  let hits: HitMap = script.hits ?? null
  let idle = script.idle ?? 60
  let postResult: PostResult = script.postResult ?? { ok: true }
  const posts: { action: PostAction; guard: PostGuard }[] = []
  const captures: CaptureOpts[] = []
  const activations: number[] = []
  const released: { mods: Mod[]; button?: Button }[] = []
  const requested: ('screen' | 'ax')[] = []
  const f = {
    posts, captures, activations, released, requested, killed: 0, aborted: 0, disposed: false,
    setStatus(s: Partial<DriverStatus>) { status = { ...status, ...s } },
    setFront(h: WinHit | null) { front = h },
    setHitMap(h: HitMap) { hits = h },
    setIdle(n: number) { idle = n },
    setPostResult(r: PostResult) { postResult = r },
    async status() { return status },
    async request(k: 'screen' | 'ax') { requested.push(k) },
    async capture(o: CaptureOpts): Promise<CaptureResult> {
      captures.push(o)
      return {
        width: 1000, height: 625, jpegBase64: 'ZmFrZQ==', display: status.display, cursor: { x: 0, y: 0 }, blocked: [],
        ...script.capture,
      }
    },
    async crop() { return { jpegBase64: 'ZmFrZQ==', sig: 'AAAA' } },
    async hitTest(p: Pt): Promise<WinHit | null> {
      if (typeof hits === 'function') return hits(p)
      if (Array.isArray(hits)) return hits.find((e) => inside(e.rect, p))?.hit ?? null
      return hits
    },
    async front() { return front },
    async post(action: PostAction, guard: PostGuard) { posts.push({ action, guard }); return postResult },
    async activate(pid: number) { activations.push(pid) },
    async release(o: { mods: Mod[]; button?: Button }) { released.push(o) },
    async idleSeconds() { return idle },
    async runningApps() { return script.apps ?? [] },
    async abort() { f.aborted++; return script.abort ?? 'stopped' },
    kill() { f.killed++ },
    dispose() { f.disposed = true },
  }
  return f satisfies ComputerDriver & Record<string, unknown>
}
export type FakeDriver = ReturnType<typeof fakeDriver>
