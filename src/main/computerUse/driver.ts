import type { Mod, NamedKey } from '@shared/computerUse'
import {
  type ActAction, type ActRequest, type ActResult, type Delivery, type Instance, type ResolveResult,
  type SnapNodeWire, type SnapshotResult,
} from '@shared/computerUse'
import { spawn as nodeSpawn } from 'node:child_process'
import { helperDriver, type SpawnLike } from './helperDriver'

// Ruling R1: these 8 wire types live in src/shared/computerUse.ts (renderer/shared code must never import this
// file); re-exported here so every main-side consumer can import them from driver.ts as before.
export type { ActAction, ActRequest, ActResult, Delivery, Instance, ResolveResult, SnapNodeWire, SnapshotResult }

export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

export interface DisplaySig { id: number; widthPt: number; heightPt: number; backing: number }
export interface DriverStatus {
  osVersion: string; osOK: boolean; screen: boolean; ax: boolean
  locked: boolean; onConsole: boolean; asleep: boolean; secureInput: boolean
  display: DisplaySig
  /** forge-cu can disclaim agent spawns (responsibility_spawnattrs_setdisclaim present); false → computer use refuses */
  disclaim?: boolean
}
export interface WinHit { pid: number; bundleId?: string; name?: string; layer: number; windowId?: number; inMenuBar?: boolean }

export type PostAction =
  | { kind: 'click'; x: number; y: number; button: 'left' | 'right' | 'middle'; count: 1 | 2 | 3; mods: Mod[] }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'drag'; from: Pt; to: Pt; button: 'left'; mods: Mod[] }
  | { kind: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; code?: number; char?: string; mods: Mod[]; repeat: number }

export interface PostGuard {
  denyPids: number[]; denyBundlePrefixes: string[]
  expectPid?: number; expectWindowId?: number; pointer?: Pt
  /** drag only: the window under the drop point that the user approved; the helper checks both at release */
  expectEndPid?: number; expectEndWindowId?: number
}
/** `locked` / `denied` come only from the service's guarded wrapper (I-4, M-1), never from the helper. */
export type PostResult = { ok: true } | { ok: false; code: 'target_changed' | 'helper_failed' | 'stopped' | 'locked' | 'denied'; typed?: number }

export interface CaptureOpts {
  maxW: number; maxH: number; quality: number; maskPids: number[]; maskBundlePrefixes: string[]
  code?: string; region?: Rect
}
export interface CaptureResult {
  width: number; height: number; jpegBase64: string; display: DisplaySig; cursor: Pt; blocked: Rect[]
}
export interface CropOpts { rectPt: Rect; marker: Pt[]; maskPids: number[]; maskBundlePrefixes: string[]; /** downscale: long edge in px (thumbnails) */ maxW?: number }
export type Button = 'left' | 'right' | 'middle'

// ───────────────────────── AX ref ops (T4): opts/results around the shared wire types ─────────────────────────

/** Accepted (optional) on snapshot / waitFor / appKey / launch / focusWindow — the own prefix is refused regardless. */
export interface CuGuard { denyPids: number[]; denyBundlePrefixes: string[] }
/** act's guard is mandatory and additionally pins the instance the caller resolved against (stale-target check). */
export interface ActGuard extends CuGuard { expectInstance: Instance }

export interface SnapshotOpts {
  app: { bundleId: string } | { pid: number }
  window?: number
  root?: string
  mode: 'skeleton' | 'full'
  maxDepth?: number
  interactiveOnly?: boolean
  /** default 3000; the TS timeout is this + 4000 (Electron activation may extend the helper deadline by ≤3 s) */
  deadlineMs?: number
  guard?: CuGuard
}

export interface WaitForMatch { role?: string; name?: string; nameContains?: string }
export interface WaitForOpts {
  pid: number
  match: WaitForMatch
  gone?: boolean
  /** default 5000 (mirrors the helper's own default); also seeds the TS timeout unless deadlineMs is longer */
  timeoutMs?: number
  deadlineMs?: number
  guard?: CuGuard
}
export interface WaitForResult { found: boolean; snapId?: string; node?: SnapNodeWire }

export interface LaunchOpts {
  bundleId?: string
  name?: string
  activate: boolean
  deadlineMs?: number
  guard?: CuGuard
}
export interface LaunchResult { instance: Instance; bundleId: string; name: string; windows: { number: number; title?: string }[] }

export interface FocusWindowOpts { pid: number; windowNumber?: number; deadlineMs?: number; guard?: CuGuard }

export interface WindowsOpts { pid?: number; deadlineMs?: number }
export interface WindowInfo { pid: number; bundleId?: string; name?: string; number: number; title?: string }
export interface WindowsResult { windows: WindowInfo[] }

export interface AppKeyOpts {
  pid: number
  mods: Mod[]
  key: { named: NamedKey } | { char: string }
  repeat: number
  deadlineMs?: number
  guard?: CuGuard
}
export interface AppKeyResult { via: 'menu' | 'confirm' | 'cancel' | 'pid'; delivery: Delivery }

export interface ComputerDriver {
  status(): Promise<DriverStatus>
  request(kind: 'screen' | 'ax'): Promise<void>
  capture(o: CaptureOpts): Promise<CaptureResult>
  /** sig: 32x32 gray, base64 */
  crop(o: CropOpts): Promise<{ jpegBase64: string; sig: string }>
  hitTest(p: Pt): Promise<WinHit | null>
  front(): Promise<WinHit | null>
  post(a: PostAction, g: PostGuard): Promise<PostResult>
  activate(pid: number): Promise<void>
  release(o: { mods: Mod[]; button?: Button }): Promise<void>
  idleSeconds(kind?: 'any' | 'mouseDown' | 'keyDown'): Promise<number>
  runningApps(): Promise<{ bundleId: string; name: string; pid: number; active: boolean }[]>
  snapshot(o: SnapshotOpts): Promise<SnapshotResult>
  resolve(ref: string): Promise<ResolveResult>
  act(r: ActRequest, guard: ActGuard): Promise<ActResult>
  waitFor(o: WaitForOpts): Promise<WaitForResult>
  launch(o: LaunchOpts): Promise<LaunchResult>
  focusWindow(o: FocusWindowOpts): Promise<void>
  windows(o: WindowsOpts): Promise<WindowsResult>
  appKey(o: AppKeyOpts): Promise<AppKeyResult>
  a11yRevert(): Promise<{ reverted: number[] }>
  abort(): Promise<'stopped' | 'killed'>
  kill(): void
  dispose(): void
}

/** Driver failure with a stable code (helper_failed, unsupported, or whatever code the helper replied with).
 *  `extra` carries wire fields `strict()` would otherwise drop: `steps`, `physical_delivery_started`,
 *  `candidates` (ambiguous_target), `via` (appKey), `typed` (a partial type delivery count). */
export class CuDriverError extends Error {
  constructor(
    public readonly code: string, message?: string, public readonly delivery?: Delivery,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message ?? code)
    this.name = 'CuDriverError'
  }
}

export function unsupportedDriver(reason: 'platform' | 'headless'): ComputerDriver {
  const no = <T>(): Promise<T> => Promise.reject(new CuDriverError('unsupported', reason))
  return {
    status: no, request: no, capture: no, crop: no, hitTest: no, front: no, post: no, activate: no,
    release: no, idleSeconds: no, runningApps: no, abort: no,
    snapshot: no, resolve: no, act: no, waitFor: no, launch: no, focusWindow: no, windows: no, appKey: no, a11yRevert: no,
    kill() {}, dispose() {},
  }
}

export function createDriver(
  platform: NodeJS.Platform,
  o: { helperPath: () => string | null; ownerPid: number; spawn?: SpawnLike; log?: (m: string) => void },
): ComputerDriver {
  if (platform !== 'darwin') return unsupportedDriver('platform')
  return helperDriver({
    helperPath: o.helperPath, ownerPid: o.ownerPid, log: o.log,
    spawn: o.spawn ?? (nodeSpawn as unknown as SpawnLike),
  })
}
