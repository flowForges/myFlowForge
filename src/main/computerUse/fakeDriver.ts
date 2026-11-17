import type { Mod } from '@shared/computerUse'
import {
  CuDriverError,
  type ActGuard, type ActRequest, type ActResult, type AppKeyOpts, type AppKeyResult, type Button,
  type CaptureOpts, type CaptureResult, type ComputerDriver, type CropOpts, type Delivery, type DisplaySig,
  type DriverStatus, type FocusWindowOpts, type Instance, type LaunchOpts, type LaunchResult, type PostAction,
  type PostGuard, type PostResult, type Pt, type Rect, type ResolveResult, type SnapNodeWire, type SnapshotOpts,
  type SnapshotResult, type WaitForOpts, type WaitForResult, type WinHit, type WindowsOpts, type WindowsResult,
} from './driver'

const DISPLAY: DisplaySig = { id: 1, widthPt: 1792, heightPt: 1120, backing: 2 }
const inside = (r: Rect, p: Pt) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h

export type HitMap = ((p: Pt) => WinHit | null) | WinHit | null | { rect: Rect; hit: WinHit }[]

// ───────────────────────── AX world (T4): a programmable app/tree set for snapshot / resolve / act / … ─────────────────────────

/** One app in the fake AX world. `tree` nodes may carry a *local* `ref` (e.g. `e1`); snapshot() qualifies it to
 * `@<snapId>:e1` (spec ref format) so resolve/act can look the node back up from the ref alone. */
export interface AxApp {
  instance: Instance
  bundleId: string
  name: string
  windows: { number: number; title?: string }[]
  tree: SnapNodeWire[]
}

const qualifyRef = (snapId: string, local: string) => `@${snapId}:${local}`
const parseRef = (ref: string): { snapId: string; local: string } | null => {
  const m = /^@(s\d+):(.+)$/.exec(ref)
  return m ? { snapId: m[1], local: m[2] } : null
}
const sameInstance = (a: Instance, b: Instance) => a.pid === b.pid && a.start === b.start

export interface AxActError { code: string; message?: string; delivery?: Delivery }

export interface FakeDriverScript {
  status?: Partial<DriverStatus>
  front?: WinHit | null
  hits?: HitMap
  idle?: number
  postResult?: PostResult
  apps?: { bundleId: string; name: string; pid: number; active: boolean }[]
  capture?: Partial<CaptureResult>
  abort?: 'stopped' | 'killed'
  /** the programmable AX world: apps snapshot/resolve/act/launch/… can see */
  ax?: { apps: AxApp[] }
  actResult?: ActResult
  /** when set, act() rejects with this instead of returning actResult (cleared with setActError(null)) */
  actError?: AxActError | null
  waitForResult?: WaitForResult
  appKeyResult?: AppKeyResult
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
  const crops: CropOpts[] = []
  let cropSig = 'AAAA'
  const activations: number[] = []
  const released: { mods: Mod[]; button?: Button }[] = []
  const requested: ('screen' | 'ax')[] = []

  // AX world state (T4)
  let axApps: AxApp[] = script.ax?.apps ?? []
  let actResult: ActResult = script.actResult ?? { delivery: 'delivered_verified', steps: [{ name: 'act', outcome: 'delivered_verified' }] }
  let actError: AxActError | null = script.actError ?? null
  let waitForResult: WaitForResult = script.waitForResult ?? { found: true }
  let appKeyResult: AppKeyResult = script.appKeyResult ?? { via: 'pid', delivery: 'delivered_unverified' }
  let snapSeq = 0
  const snapRegistry = new Map<string, { app: AxApp; nodes: SnapNodeWire[] }>()
  const snapshots: SnapshotOpts[] = []
  const resolves: string[] = []
  const acts: { req: ActRequest; guard: ActGuard }[] = []
  const waitFors: WaitForOpts[] = []
  const launches: LaunchOpts[] = []
  const focusWindows: FocusWindowOpts[] = []
  const windowsCalls: WindowsOpts[] = []
  const appKeys: AppKeyOpts[] = []
  let a11yReverts = 0

  const findApp = (want: { bundleId: string } | { pid: number }): AxApp | undefined =>
    'bundleId' in want ? axApps.find((a) => a.bundleId === want.bundleId) : axApps.find((a) => a.instance.pid === want.pid)
  const lookupRef = (ref: string): { app: AxApp; node: SnapNodeWire } | null => {
    const p = parseRef(ref)
    if (!p) return null
    const snap = snapRegistry.get(p.snapId)
    if (!snap) return null
    const node = snap.nodes.find((n) => n.ref === ref)
    return node ? { app: snap.app, node } : null
  }

  const f = {
    posts, captures, crops, activations, released, requested, killed: 0, aborted: 0, disposed: false,
    snapshots, resolves, acts, waitFors, launches, focusWindows, windowsCalls, appKeys,
    get a11yReverts() { return a11yReverts },
    setStatus(s: Partial<DriverStatus>) { status = { ...status, ...s } },
    setFront(h: WinHit | null) { front = h },
    setHitMap(h: HitMap) { hits = h },
    setIdle(n: number) { idle = n },
    setCropSig(s: string) { cropSig = s },
    setPostResult(r: PostResult) { postResult = r },
    setAxApps(apps: AxApp[]) { axApps = apps },
    setActResult(r: ActResult) { actResult = r },
    setActError(e: AxActError | null) { actError = e },
    setWaitForResult(r: WaitForResult) { waitForResult = r },
    setAppKeyResult(r: AppKeyResult) { appKeyResult = r },
    async status() { return status },
    async request(k: 'screen' | 'ax') { requested.push(k) },
    async capture(o: CaptureOpts): Promise<CaptureResult> {
      captures.push(o)
      return {
        width: 1000, height: 625, jpegBase64: 'ZmFrZQ==', display: status.display, cursor: { x: 0, y: 0 }, blocked: [],
        ...script.capture,
      }
    },
    async crop(o: CropOpts) { crops.push(o); return { jpegBase64: 'ZmFrZQ==', sig: cropSig } },
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
    async snapshot(o: SnapshotOpts): Promise<SnapshotResult> {
      snapshots.push(o)
      const app = findApp(o.app)
      if (!app) throw new CuDriverError('not_found')
      const snapId = `s${++snapSeq}`
      const nodes = app.tree.map((n) => ({ ...n, ref: n.ref ? qualifyRef(snapId, n.ref) : undefined }))
      snapRegistry.set(snapId, { app, nodes })
      const win = app.windows[0]
      return {
        snapId, instance: app.instance, app: { bundleId: app.bundleId, name: app.name },
        window: win ? { number: win.number, title: win.title } : {},
        complete: true, nodes,
      }
    },
    async resolve(ref: string): Promise<ResolveResult> {
      resolves.push(ref)
      const hit = lookupRef(ref)
      if (!hit) throw new CuDriverError('stale_ref')
      const { app, node } = hit
      return { instance: app.instance, bundleId: app.bundleId, appName: app.name, role: node.role, name: node.name, bounds: node.bounds }
    },
    async act(req: ActRequest, guard: ActGuard): Promise<ActResult> {
      acts.push({ req, guard })
      const hit = lookupRef(req.ref)
      if (!hit) throw new CuDriverError('stale_ref', undefined, 'not_delivered')
      if (!sameInstance(guard.expectInstance, hit.app.instance)) throw new CuDriverError('target_changed', undefined, 'not_delivered')
      if (actError) throw new CuDriverError(actError.code, actError.message, actError.delivery)
      return actResult
    },
    async waitFor(o: WaitForOpts): Promise<WaitForResult> { waitFors.push(o); return waitForResult },
    async launch(o: LaunchOpts): Promise<LaunchResult> {
      launches.push(o)
      const app = o.bundleId ? findApp({ bundleId: o.bundleId }) : axApps.find((a) => a.name === o.name)
      if (!app) throw new CuDriverError('not_found')
      return { instance: app.instance, bundleId: app.bundleId, name: app.name, windows: app.windows }
    },
    async focusWindow(o: FocusWindowOpts): Promise<void> {
      focusWindows.push(o)
      if (!findApp({ pid: o.pid })) throw new CuDriverError('not_found')
    },
    async windows(o: WindowsOpts): Promise<WindowsResult> {
      windowsCalls.push(o)
      const apps = o.pid !== undefined ? axApps.filter((a) => a.instance.pid === o.pid) : axApps
      return { windows: apps.flatMap((a) => a.windows.map((w) => ({ ...w, pid: a.instance.pid, bundleId: a.bundleId, name: a.name }))) }
    },
    async appKey(o: AppKeyOpts): Promise<AppKeyResult> { appKeys.push(o); return appKeyResult },
    async a11yRevert() { a11yReverts++; return { reverted: axApps.map((a) => a.instance.pid) } },
    async abort() { f.aborted++; return script.abort ?? 'stopped' },
    kill() { f.killed++ },
    dispose() { f.disposed = true },
  }
  return f satisfies ComputerDriver & Record<string, unknown>
}
export type FakeDriver = ReturnType<typeof fakeDriver>
