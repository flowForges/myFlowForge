// Executor: the guarded pipeline every computer-use tool call goes through (spec §5.6, §6, V6–V9).
//
// It runs inside the service's FIFO, one call at a time, and must be built with `driver: svc.driver` (the service's
// guarded wrapper), never the raw driver. It never writes the vision / step-limit notes: `svc.stop(key, why)` does.
//
// Secrets: the typed text goes to the driver's `post` and to the approval gate only. The action log gets a length and,
// for the live session's memory, a 40-character preview (V11). Nothing here logs.
import { randomInt } from 'node:crypto'
import {
  classify, CU_ERR, CU_SCHEMAS, OWN_BUNDLE_PREFIX, parseCombo, prettyCombo, screenNotice, screenshotSize,
  toPoint, visibleText, wrapUntrusted, comboKeycode,
  type CuActionKind, type CuActionView, type CuClass, type CuErrCode, type Mod, type ParsedCombo,
} from '@shared/computerUse'
import type { Settings } from '../config/schema'
import {
  CuDriverError, type ComputerDriver, type DisplaySig, type PostAction, type PostGuard, type Pt, type Rect, type WinHit,
} from './driver'
import type { ActionLog, CallMeta, CuLogEntry, CuOp, CuResult, CuSessionKey, Executor, GateDecision, ServiceInternals } from './types'

export interface ExecutorDeps {
  svc: ServiceInternals
  /** pass `svc.driver` */
  driver: ComputerDriver
  now: () => number
  sleep: (ms: number) => Promise<void>
  settings: () => Settings['computerUse']
  ownPid: number
  ownAccelerators: () => string[]
  log: ActionLog
  /** V5 / R18: only when true do we pause for a user who is touching the keyboard or mouse */
  hidIsPhysical: () => boolean
}

/** For `createComputerUseService({ executorFactory })`: builds the executor on the service's guarded driver. */
export const executorFactoryFor = (rest: Omit<ExecutorDeps, 'svc' | 'driver'>) => (svc: ServiceInternals): Executor =>
  createExecutor({ ...rest, svc, driver: svc.driver })

export const VISION_ALPHABET = 'ACEFHJKLMNPRTUVWXY3479'
export const STEP_GATE = 100
export const TURN_SHOT_CAP = 300
export const ENABLE_INPUT_CAP = 2000
export const STALE_GATE_MS = 15_000
export const SIG_DIFF_LIMIT = 0.08
export const POST_FLOOR_MS = 150
export const POST_PER_S = 5
export const SHOT_PER_S = 2
export const MAX_RATE_WAIT_MS = 2000
export const IDLE_PAUSE_S = 1.5
const WINDOW_MS = 1000
const CROP_PHYS_W = 480
const CROP_PHYS_H = 320
const PREVIEW_CHARS = 40
const THUMB_EDGE = 320
const MISSING_CODE_FREE = 3
const MAX_STATES = 8

const INPUT_OPS: ReadonlySet<CuOp> = new Set<CuOp>(['click', 'move', 'drag', 'scroll', 'type', 'key'])
const POINTER_OPS: ReadonlySet<CuOp> = new Set<CuOp>(['click', 'move', 'drag', 'scroll'])

interface Shot { id: string; widthPt: number; heightPt: number; scale: number; width: number; height: number; display: DisplaySig }
interface State {
  enable: number; turn: number
  shotSeq: number; shot?: Shot
  code: string; verified: boolean; misses: number; missing: number
  inputsEnable: number
  inputsTurn: number; allowance: number; shotsTurn: number
}

const sameDisplay = (a: DisplaySig, b: DisplaySig) => a.id === b.id && a.widthPt === b.widthPt && a.heightPt === b.heightPt && a.backing === b.backing
const fail = (code: CuErrCode, extra?: string): CuResult => ({ ok: false, code, text: extra ? `${CU_ERR[code]} · ${extra}` : CU_ERR[code] })
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d
const keyOf = (k: CuSessionKey) => JSON.stringify([k.workspacePath, k.sessionId])

/** mean absolute difference of two base64 gray signatures, 0..1; anything malformed counts as completely different */
export function sigDiff(a: string, b: string): number {
  const x = Buffer.from(a, 'base64'), y = Buffer.from(b, 'base64')
  if (x.length === 0 || x.length !== y.length) return 1
  let sum = 0
  for (let i = 0; i < x.length; i++) sum += Math.abs(x[i] - y[i])
  return sum / x.length / 255
}

const newCode = () => Array.from({ length: 4 }, () => VISION_ALPHABET[randomInt(VISION_ALPHABET.length)]).join('')

export function createExecutor(d: ExecutorDeps): Executor {
  const states = new Map<string, State>()
  const postTimes: number[] = []
  const shotTimes: number[] = []
  let lastPost = -Infinity

  function stateFor(key: CuSessionKey): State {
    const k = keyOf(key)
    const enable = d.svc.enableSeq(key)
    const turn = d.svc.turnSeq(key)
    let s = states.get(k)
    if (!s || s.enable !== enable) {
      s = {
        enable, turn, shotSeq: 0, code: newCode(), verified: false, misses: 0, missing: 0,
        inputsEnable: 0, inputsTurn: 0, allowance: STEP_GATE, shotsTurn: 0,
      }
      states.delete(k)
      states.set(k, s)
      while (states.size > MAX_STATES) states.delete(states.keys().next().value as string)
    }
    if (s.turn !== turn) { s.turn = turn; s.inputsTurn = 0; s.allowance = STEP_GATE; s.shotsTurn = 0 }
    return s
  }

  /** Sliding-window limit + optional floor. Waits (never errors) up to 2 s in total, then gives `rate_limited`. */
  async function pace(times: number[], perSecond: number, floor: boolean): Promise<boolean> {
    let waited = 0
    for (;;) {
      const t = d.now()
      while (times.length && t - times[0] >= WINDOW_MS) times.shift()
      let wait = 0
      if (times.length >= perSecond) wait = Math.max(wait, times[0] + WINDOW_MS - t)
      if (floor) wait = Math.max(wait, lastPost + POST_FLOOR_MS - t)
      if (wait <= 0) return true
      if (waited + wait > MAX_RATE_WAIT_MS) return false
      await d.sleep(wait)
      waited += wait
    }
  }

  async function record(key: CuSessionKey, e: Omit<CuLogEntry, 'ts' | 'turn'>, thumb?: string): Promise<void> {
    try {
      const out = await d.log.append(key, { ts: d.now(), turn: d.svc.turnSeq(key), ...e }, thumb)
      d.svc.emitAction(key, out)
    } catch { /* the log is best effort; it never blocks or leaks */ }
  }

  const fromDriverError = (e: unknown): CuResult => {
    const code = e instanceof CuDriverError ? e.code : ''
    return fail(Object.prototype.hasOwnProperty.call(CU_ERR, code) ? (code as CuErrCode) : 'helper_failed')
  }

  function classOf(h: { pid: number; bundleId?: string; name?: string; inMenuBar?: boolean }, kind: CuActionKind, combo: ParsedCombo | null, frontIsOwn: boolean): CuClass {
    const s = d.settings()
    return classify(h, kind, combo, {
      ownPid: d.ownPid, extraBlocked: s.extraBlocked, extraAskAlways: s.extraAskAlways,
      ownAccelerators: d.ownAccelerators(), frontIsOwn,
    })
  }

  const label = (h: { name?: string; bundleId?: string }) => wrapUntrusted(h.name ?? h.bundleId ?? '未知应用')

  async function tryCrop(rect: Rect, marker: Pt[], maxW?: number) {
    try {
      return await d.driver.crop({ rectPt: rect, marker, maskPids: [d.ownPid], maskBundlePrefixes: [OWN_BUNDLE_PREFIX], ...(maxW ? { maxW } : {}) })
    } catch { return null }
  }

  // ───────────────────────── non-input tools ─────────────────────────

  async function screenshot(key: CuSessionKey, st: State, a: { region?: { x: number; y: number; w: number; h: number } }, display: DisplaySig): Promise<CuResult> {
    if (st.shotsTurn >= TURN_SHOT_CAP) return fail('step_limit', `本轮截图已达 ${TURN_SHOT_CAP} 张`)
    let region: Rect | undefined
    if (a.region) {
      if (!st.shot) return fail('need_screenshot')
      if (!sameDisplay(st.shot.display, display)) return fail('layout_changed')
      const k = st.shot.scale
      const x = a.region.x / k, y = a.region.y / k
      region = {
        x, y,
        w: Math.min(a.region.w / k, display.widthPt - x),
        h: Math.min(a.region.h / k, display.heightPt - y),
      }
      if (region.w < 1 || region.h < 1) return fail('invalid_args', '区域在屏幕之外')
    }
    if (!(await pace(shotTimes, SHOT_PER_S, false))) return fail('rate_limited')
    shotTimes.push(d.now())
    st.shotsTurn++
    const size = screenshotSize(display)
    let r
    try {
      r = await d.driver.capture({
        maxW: region ? 1280 : size.width, maxH: region ? 1280 : size.height, quality: 0.75,
        maskPids: [d.ownPid], maskBundlePrefixes: [OWN_BUNDLE_PREFIX],
        ...(st.verified ? {} : { code: st.code }),
        ...(region ? { region } : {}),
      })
    } catch (e) { return fromDriverError(e) }
    const shotId = `s${++st.shotSeq}`
    const scale = r.width / r.display.widthPt
    const frame = region ? (st.shot as Shot) : null
    if (!region) {
      st.shot = { id: shotId, widthPt: r.display.widthPt, heightPt: r.display.heightPt, scale, width: r.width, height: r.height, display: r.display }
    }
    const fs = frame ? frame.scale : scale
    const front = await d.driver.front().catch(() => null)
    const meta: Record<string, unknown> = {
      shotId, width: r.width, height: r.height, scale: round(fs),
      display: { widthPt: r.display.widthPt, heightPt: r.display.heightPt, backingScale: r.display.backing },
      cursor: { x: Math.round(r.cursor.x * fs), y: Math.round(r.cursor.y * fs) },
      frontApp: front ? { name: label(front), bundleId: wrapUntrusted(front.bundleId ?? '') } : null,
      blocked: r.blocked.map((b) => ({ x: Math.round(b.x * fs), y: Math.round(b.y * fs), w: Math.round(b.w * fs), h: Math.round(b.h * fs) })),
    }
    if (region) {
      meta.region = {
        x: a.region!.x, y: a.region!.y, w: a.region!.w, h: a.region!.h,
        regionScale: round(r.width / Math.max(1, a.region!.w)),
      }
    }
    let text = `${screenNotice(shotId)}\n${JSON.stringify(meta)}`
    if (region) text += '\n后续坐标仍按全屏截图'
    return { ok: true, text, image: { data: r.jpegBase64, mimeType: 'image/jpeg' } }
  }

  async function cursor(st: State, display: DisplaySig): Promise<CuResult> {
    if (st.shotsTurn >= TURN_SHOT_CAP) return fail('step_limit', `本轮截图已达 ${TURN_SHOT_CAP} 张`)
    if (!(await pace(shotTimes, SHOT_PER_S, false))) return fail('rate_limited')
    shotTimes.push(d.now())
    st.shotsTurn++
    try {
      const r = await d.driver.capture({
        maxW: 16, maxH: 16, quality: 0.3, maskPids: [d.ownPid], maskBundlePrefixes: [OWN_BUNDLE_PREFIX],
        region: { x: 0, y: 0, w: 16, h: 16 },
      })
      const k = st.shot && sameDisplay(st.shot.display, display) ? st.shot.scale : screenshotSize(display).scale
      const onMain = r.cursor.x >= 0 && r.cursor.y >= 0 && r.cursor.x < display.widthPt && r.cursor.y < display.heightPt
      return { ok: true, text: JSON.stringify({ x: Math.round(r.cursor.x * k), y: Math.round(r.cursor.y * k), onMainDisplay: onMain }) }
    } catch (e) { return fromDriverError(e) }
  }

  async function frontApp(): Promise<CuResult> {
    let f
    try { f = await d.driver.front() } catch (e) { return fromDriverError(e) }
    if (!f) return { ok: true, text: '没有前台应用' }
    return { ok: true, text: JSON.stringify({ name: label(f), bundleId: wrapUntrusted(f.bundleId ?? '') }) }
  }

  // ───────────────────────── input tools ─────────────────────────

  interface Plan {
    kind: CuActionKind
    action: PostAction
    view: CuActionView
    /** window / app the action lands on; the first one is the guard's expectation */
    targets: WinHit[]
    pts: Pt[]
    pointer: boolean
    combo: ParsedCombo | null
    /** what may be stored: a bare printable key could be part of typed text (M-6) */
    logCombo?: string
    done: (app: string) => string
  }

  async function input(key: CuSessionKey, st: State, op: CuOp, a: Record<string, any>, status: Awaited<ReturnType<ComputerDriver['status']>>): Promise<CuResult> {
    const pointer = POINTER_OPS.has(op)
    const kind = op as CuActionKind

    // coordinates (pointer) / a shot to read the code from
    if (pointer || !st.verified) {
      if (!st.shot) return fail('need_screenshot')
    }
    if (pointer && st.shot && !sameDisplay(st.shot.display, status.display)) return fail('layout_changed')

    // step gate (T7): refusals spend steps too, so a refused-action loop meets the gate
    if (st.inputsEnable >= ENABLE_INPUT_CAP) return fail('step_limit')
    if (st.inputsTurn >= st.allowance) {
      const dec = await d.svc.openGate({ key, kind: 'continue', reason: `已执行 ${st.inputsTurn} 步 · 继续 ${STEP_GATE} 步` })
      if (dec !== 'allow') return fail('step_limit')
      st.allowance += STEP_GATE
    }

    // vision check (R9): a wrong code is a miss; a missing one only after it keeps being missing
    if (!st.verified && op !== 'move') {
      const given = typeof a.visionCode === 'string' ? a.visionCode.trim().toUpperCase() : ''
      if (given && given === st.code) st.verified = true
      else {
        st.inputsTurn++
        if (given) st.misses++
        else if (++st.missing > MISSING_CODE_FREE) st.misses++
        if (st.misses >= 3) d.svc.stop(key, 'vision')
        return fail('vision_code')
      }
    }

    // a user who is using the machine (T11)
    if (d.hidIsPhysical()) {
      const idle = await d.driver.idleSeconds('any').catch(() => Infinity)
      if (idle < IDLE_PAUSE_S) return fail('user_active')
    }

    // target
    const front = await d.driver.front()
    const frontIsOwn = !!front && front.pid === d.ownPid
    let plan: Plan
    try {
      plan = await buildPlan(op, a, st, status, front)
    } catch (e) {
      if (e instanceof Reject) return e.result
      return fromDriverError(e)
    }

    const classes = plan.targets.map((t) => classOf(t, plan.kind, plan.combo, frontIsOwn))
    const block = classes.find((c): c is Extract<CuClass, { kind: 'block' }> => c.kind === 'block')
    const first = plan.targets[0]
    const baseEntry = {
      op, app: first.name, bundleId: first.bundleId,
      ...(plan.pointer ? { at: (plan.view.at as Pt) } : {}),
      ...(op === 'type' ? { textLen: Array.from(a.text as string).length, textPreview: preview(a.text as string) } : {}),
      ...(op === 'key' ? { combo: plan.logCombo } : {}),
    }
    if (block) {
      st.inputsTurn++
      await record(key, { ...baseEntry, result: 'blocked', code: block.code })
      return fail(block.code)
    }
    if ((op === 'type' || op === 'key') && status.secureInput) {
      st.inputsTurn++
      await record(key, { ...baseEntry, result: 'blocked', code: 'secure_input' })
      return fail('secure_input')
    }

    const thumbOf = async (): Promise<string | undefined> =>
      plan.pointer && op !== 'move' ? (await tryCrop(cropRect(plan.pts, status.display.backing), plan.pts, THUMB_EDGE))?.jpegBase64 : undefined

    // approval (T3, §5.7)
    const ask = classes.find((c): c is Extract<CuClass, { kind: 'askAlways' }> => c.kind === 'askAlways')
    const mode = d.svc.modeOf(key)
    const needGate = op !== 'move' && (mode === 'ask' || !!ask)
    let crop: { jpegBase64: string; sig: string } | null = null
    let gated = false
    if (needGate) {
      if (plan.pointer) {
        crop = await tryCrop(cropRect(plan.pts, status.display.backing), plan.pts)
        if (!crop) return fail('helper_failed')
      }
      let opened = d.now()
      let decision = await d.svc.openGate({ key, kind: 'action', action: plan.view, crop: crop?.jpegBase64, reason: ask?.reason })
      if (decision === 'allow' && crop && d.now() - opened > STALE_GATE_MS) {
        // V9: what was under the target when the card was shown may not be there any more
        const fresh = await tryCrop(cropRect(plan.pts, status.display.backing), plan.pts)
        if (!fresh) return fail('helper_failed')
        if (sigDiff(crop.sig, fresh.sig) > SIG_DIFF_LIMIT) {
          crop = fresh
          opened = d.now()
          decision = await d.svc.openGate({ key, kind: 'action', action: plan.view, crop: fresh.jpegBase64, reason: ask?.reason })
        }
      }
      const denied = gateFailure(decision)
      if (denied) {
        await record(key, { ...baseEntry, result: 'denied', code: denied }, await thumbOf())
        return fail(denied)
      }
      gated = true
    }

    // give the focus back to the target if answering took it (V9)
    if (gated) {
      let f = await d.driver.front()
      if (f && f.pid === d.ownPid) {
        await d.driver.activate(first.pid)
        await d.sleep(150)
        f = await d.driver.front()
        if (f && f.pid === d.ownPid) {
          await record(key, { ...baseEntry, result: 'failed', code: 'target_changed' }, await thumbOf())
          return fail('target_changed')
        }
      }
    }

    // atomic execution (R8)
    if (!(await pace(postTimes, POST_PER_S, true))) {
      await record(key, { ...baseEntry, result: 'failed', code: 'rate_limited' }, await thumbOf())
      return fail('rate_limited')
    }
    // I-2: the pace wait can be long; what is under every point must still be what was approved and classified
    if (plan.pointer) {
      for (let i = 0; i < plan.pts.length; i++) {
        const now = await d.driver.hitTest(plan.pts[i])
        const want = plan.targets[i]
        if (!now || now.pid !== want.pid || now.windowId !== want.windowId) {
          await record(key, { ...baseEntry, result: 'failed', code: 'target_changed' }, await thumbOf())
          return fail('target_changed')
        }
      }
    }
    const end = op === 'drag' ? plan.targets[1] : undefined
    const guard: PostGuard = {
      denyPids: [d.ownPid], denyBundlePrefixes: [OWN_BUNDLE_PREFIX],
      expectPid: first.pid,
      ...(first.windowId !== undefined ? { expectWindowId: first.windowId } : {}),
      ...(op === 'scroll' ? { pointer: plan.pts[0] } : {}),
      ...(end ? { expectEndPid: end.pid, ...(end.windowId !== undefined ? { expectEndWindowId: end.windowId } : {}) } : {}),
    }
    const t = d.now()
    postTimes.push(t)
    lastPost = t
    st.inputsTurn++
    st.inputsEnable++
    let res
    try { res = await d.driver.post(plan.action, guard) } catch { res = { ok: false as const, code: 'helper_failed' as const } }
    if (st.inputsEnable >= ENABLE_INPUT_CAP) d.svc.stop(key, 'limit')

    if (!res.ok) {
      const code: CuErrCode = res.code
      await record(key, { ...baseEntry, result: 'failed', code }, await thumbOf())
      if (code === 'target_changed' && typeof res.typed === 'number') {
        return fail('target_changed', `已输入 ${res.typed} 个字符后目标变了`)
      }
      return fail(code)
    }

    await record(key, { ...baseEntry, result: gated ? 'allowed' : 'auto' }, await thumbOf())
    return { ok: true, text: plan.done(label(first)) }
  }

  class Reject { constructor(public result: CuResult) {} }

  async function buildPlan(op: CuOp, a: Record<string, any>, st: State, status: { display: DisplaySig }, front: WinHit | null): Promise<Plan> {
    const shot = st.shot
    const px = (p: Pt) => ({ x: p.x, y: p.y })
    const hitAt = async (p: Pt) => {
      const h = await d.driver.hitTest(p)
      if (!h) throw new Reject(fail('target_changed'))
      return h
    }
    const mods: Mod[] = (a.modifiers as Mod[] | undefined) ?? []
    switch (op) {
      case 'click': {
        const p = toPoint(a as Pt, shot!)
        const h = await hitAt(p)
        const button = (a.button as 'left' | 'right' | 'middle' | undefined) ?? 'left'
        const count = (a.clicks as 1 | 2 | 3 | undefined) ?? 1
        return {
          kind: 'click', pointer: true, targets: [h], pts: [p], combo: null,
          action: { kind: 'click', x: p.x, y: p.y, button, count, mods },
          view: { kind: 'click', app: h.name, bundleId: h.bundleId, at: px(a as Pt), button, count, mods },
          done: (app) => `已点击 (${a.x}, ${a.y}) · 目标 ${app}`,
        }
      }
      case 'move': {
        const p = toPoint(a as Pt, shot!)
        const h = await hitAt(p)
        return {
          kind: 'move', pointer: true, targets: [h], pts: [p], combo: null,
          action: { kind: 'move', x: p.x, y: p.y },
          view: { kind: 'move', app: h.name, bundleId: h.bundleId, at: px(a as Pt) },
          done: () => `已移动到 (${a.x}, ${a.y})`,
        }
      }
      case 'drag': {
        const from = toPoint(a.from, shot!), to = toPoint(a.to, shot!)
        const h1 = await hitAt(from), h2 = await hitAt(to)
        return {
          kind: 'drag', pointer: true, targets: [h1, h2], pts: [from, to], combo: null,
          action: { kind: 'drag', from, to, button: 'left', mods },
          view: { kind: 'drag', app: h1.name, bundleId: h1.bundleId, at: px(a.from), to: px(a.to), toApp: h2.name, button: 'left', mods },
          done: (app) => `已拖动 (${a.from.x}, ${a.from.y}) → (${a.to.x}, ${a.to.y}) · 目标 ${app}`,
        }
      }
      case 'scroll': {
        const p = toPoint(a as Pt, shot!)
        const dx = (a.dx as number | undefined) ?? 0, dy = (a.dy as number | undefined) ?? 0
        if (dx === 0 && dy === 0) throw new Reject(fail('invalid_args', 'dx 和 dy 不能都是 0'))
        const h = await hitAt(p)
        return {
          kind: 'scroll', pointer: true, targets: [h], pts: [p], combo: null,
          action: { kind: 'scroll', x: p.x, y: p.y, dx, dy },
          view: { kind: 'scroll', app: h.name, bundleId: h.bundleId, at: px(a as Pt), dx, dy },
          done: () => `已滚动 (${a.x}, ${a.y}) dx=${dx} dy=${dy}`,
        }
      }
      case 'type': {
        if (!front) throw new Reject(fail('target_changed'))
        const n = Array.from(a.text as string).length
        return {
          kind: 'type', pointer: false, targets: [front], pts: [], combo: null,
          action: { kind: 'type', text: a.text },
          view: { kind: 'type', app: front.name, bundleId: front.bundleId, text: a.text },
          done: (app) => `已输入 ${n} 个字符 · 目标 ${app}`,
        }
      }
      case 'key': {
        const c = parseCombo(a.combo as string)
        if ('error' in c) throw new Reject(fail('invalid_args', `${c.error} · 可用的键名:${c.known.join(' ')}`))
        if (!front) throw new Reject(fail('target_changed'))
        const repeat = (a.repeat as number | undefined) ?? 1
        const pretty = prettyCombo(c)
        const action: PostAction = { kind: 'key', code: comboKeycode(c), mods: c.mods, repeat }
        return {
          kind: 'key', pointer: false, targets: [front], pts: [], combo: c, action,
          logCombo: c.mods.length > 0 || 'named' in c.key ? pretty : '·',
          view: { kind: 'key', app: front.name, bundleId: front.bundleId, combo: pretty, mods: c.mods, repeat },
          done: () => `已按 ${pretty}${repeat > 1 ? ` ×${repeat}` : ''}`,
        }
      }
      default:
        throw new Reject(fail('invalid_args'))
    }
  }

  const gateFailure = (dec: GateDecision): CuErrCode | null =>
    dec === 'allow' ? null : dec === 'timeout' ? 'timeout' : dec === 'stop' ? 'stopped' : 'denied'

  function preview(text: string): string {
    const chars = Array.from(visibleText(text))
    return chars.length > PREVIEW_CHARS ? chars.slice(0, PREVIEW_CHARS).join('') + '…' : chars.join('')
  }

  /** 480×320 physical pixels around the target (a drag: around both ends), in points */
  function cropRect(pts: Pt[], backing: number): Rect {
    const b = backing > 0 ? backing : 1
    const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x))
    const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y))
    const w = Math.max(CROP_PHYS_W / b, pts.length > 1 ? maxX - minX + 80 : 0)
    const h = Math.max(CROP_PHYS_H / b, pts.length > 1 ? maxY - minY + 80 : 0)
    return { x: (minX + maxX) / 2 - w / 2, y: (minY + maxY) / 2 - h / 2, w, h }
  }

  /** false = something in `a` lies outside the shot's pixel grid */
  function withinShot(sh: Shot, op: CuOp, a: Record<string, any>): boolean {
    const inside = (p: { x: number; y: number }) => p.x >= 0 && p.y >= 0 && p.x < sh.width && p.y < sh.height
    switch (op) {
      case 'click': case 'move': case 'scroll': return inside(a as Pt)
      case 'drag': return inside(a.from) && inside(a.to)
      case 'screenshot': return !a.region || (a.region.x < sh.width && a.region.y < sh.height)
      default: return true
    }
  }

  return {
    async run(key, op, rawArgs, _meta: CallMeta): Promise<CuResult> {
      const schema = (CU_SCHEMAS as Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { issues: { path: PropertyKey[] }[] } } }>)[`computer_${op}`]
      if (!schema) return fail('invalid_args')
      const parsed = schema.safeParse(rawArgs ?? {})
      if (!parsed.success) {
        const where = parsed.error?.issues[0]?.path.map(String).join('.') ?? ''
        return fail('invalid_args', where || undefined)
      }
      const a = (parsed.data ?? {}) as Record<string, any>

      if (d.svc.enableSeq(key) === 0 || d.svc.modeOf(key) === 'off') return fail('not_enabled')
      if (d.svc.turnSeq(key) === 0) return fail('no_turn')
      const st = stateFor(key)

      // I-1: a point outside the last screenshot would be clamped on its way to the screen and the card would show
      // a different place than the one that is hit, so it is refused before anything else happens
      if (st.shot && !withinShot(st.shot, op, a)) return fail('invalid_args', '坐标超出截图范围')

      let status
      try { status = await d.driver.status() } catch (e) { return fromDriverError(e) }
      if (status.locked || !status.onConsole || status.asleep) return fail('locked')
      if (!status.osOK) return fail('unsupported')
      if (!status.screen || !status.ax) return fail('no_permission')

      switch (op) {
        case 'wait':
          await d.sleep(a.ms)
          return { ok: true, text: `已等待 ${a.ms} ms` }
        case 'front_app': return frontApp()
        case 'cursor': return cursor(st, status.display)
        case 'screenshot': return screenshot(key, st, a, status.display)
        default:
          return INPUT_OPS.has(op) ? input(key, st, op, a, status) : fail('invalid_args')
      }
    },
  }
}
