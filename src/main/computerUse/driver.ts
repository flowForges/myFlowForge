import type { Mod } from '@shared/computerUse'
import { spawn as nodeSpawn } from 'node:child_process'
import { helperDriver, type SpawnLike } from './helperDriver'

export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

export interface DisplaySig { id: number; widthPt: number; heightPt: number; backing: number }
export interface DriverStatus {
  osVersion: string; osOK: boolean; screen: boolean; ax: boolean
  locked: boolean; onConsole: boolean; asleep: boolean; secureInput: boolean
  display: DisplaySig
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
}
export type PostResult = { ok: true } | { ok: false; code: 'target_changed' | 'helper_failed' | 'stopped'; typed?: number }

export interface CaptureOpts {
  maxW: number; maxH: number; quality: number; maskPids: number[]; maskBundlePrefixes: string[]
  code?: string; region?: Rect
}
export interface CaptureResult {
  width: number; height: number; jpegBase64: string; display: DisplaySig; cursor: Pt; blocked: Rect[]
}
export interface CropOpts { rectPt: Rect; marker: Pt[]; maskPids: number[]; maskBundlePrefixes: string[] }
export type Button = 'left' | 'right' | 'middle'

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
  runningApps(): Promise<{ bundleId: string; name: string }[]>
  abort(): Promise<'stopped' | 'killed'>
  kill(): void
  dispose(): void
}

/** Driver failure with a stable code (helper_failed, unsupported, or whatever code the helper replied with). */
export class CuDriverError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code)
    this.name = 'CuDriverError'
  }
}

export function unsupportedDriver(reason: 'platform' | 'headless'): ComputerDriver {
  const no = <T>(): Promise<T> => Promise.reject(new CuDriverError('unsupported', reason))
  return {
    status: no, request: no, capture: no, crop: no, hitTest: no, front: no, post: no, activate: no,
    release: no, idleSeconds: no, runningApps: no, abort: no,
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
