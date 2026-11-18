// Semantic (AX ref) tool pipeline (spec §7.1–7.3, §8.3): snapshot / act / launch / focus / key(app) / wait_for /
// windows / apps. Runs inside the service's FIFO through the same executor core as the v1 coordinate tools: the
// same enablement / turn / screen checks, the same per-turn counters and rate limits, the same log.
//
// Order for a mutating action: step gate → target (resolve / running app) → app class (own / blocked / ask-always,
// fail closed on an unknown bundle) → environment (secure input, a busy user) → approval → hider → pace → driver.
// Reads are classified too (R-10): our own app and blocked apps are never read; ask-always apps are read ungated.
// No pixel-signature re-gate (R-5): forge-cu re-resolves the ref and pins the approved instance in the same call.
//
// Secrets: typed text goes to the driver and the gate only; the log gets its length.
import {
  ACT_LABEL, BLOCKED_BUNDLES, CU_ERR, OWN_BUNDLE_PREFIX, ROLE_LABEL, isBlockedCombo, parseCombo,
  prettyCombo, retryOf, DELIVERY_SHORT, sanitizeScreenText, snapNotice, wrapUntrusted,
  type ActRequest, type CuActionView, type CuClass, type CuErrCode, type Delivery, type Instance, type SEMANTIC_TOOLS,
} from '@shared/computerUse'
import { renderNodeLine, renderSnapshot } from '@shared/cuSnapshotRender'
import { CuDriverError, LAUNCH_DEADLINE_MS, SNAPSHOT_DEADLINE_MS, type CuGuard, type Rect } from './driver'
import {
  IDLE_PAUSE_S, TURN_SHOT_CAP, coreFor, fail, fromDriverError, gateFailure, stepAside,
  type ExecCore, type ExecutorDeps,
} from './executor'
import type { CuLogEntry, CuOp, CuSessionKey } from './types'

export type SemanticTool = (typeof SEMANTIC_TOOLS)[number]
export type Retry = 'safe' | 'unsafe'
export type CuToolReply =
  | { ok: true; text: string; delivery?: Delivery; label?: string }
  | { ok: false; code: CuErrCode; text: string; delivery?: Delivery; retry: Retry }

type Fail = Extract<CuToolReply, { ok: false }>
type Target = { pid: number; bundleId?: string; name: string }

/** spec §10: the gate crop is the element's box plus some room; never smaller than v1's 480×320 physical pixels */
const CROP_PHYS_W = 480
const CROP_PHYS_H = 320
const CROP_PAD_PT = 40

/** Mutation errors that by their nature mean nothing was sent (when forge-cu didn't say). Anything else: unsafe. */
const NOTHING_SENT: ReadonlySet<CuErrCode> = new Set<CuErrCode>([
  'stale_ref', 'ambiguous_target', 'not_found', 'own_window', 'blocked_app', 'blocked_combo', 'secure_input',
  'unsupported', 'action_unsupported', 'target_changed', 'no_permission', 'denied', 'invalid_args', 'focus_failed', 'step_limit',
  'rate_limited', 'user_active', 'locked',
])

const safe = (code: CuErrCode, extra?: string): Fail => ({ ...(fail(code, extra) as Fail), retry: 'safe' })
const known = (c: string): c is CuErrCode => Object.prototype.hasOwnProperty.call(CU_ERR, c)
const isOwn = (d: ExecutorDeps, t: { pid: number; bundleId?: string }) =>
  t.pid === d.ownPid || (!!t.bundleId && t.bundleId.startsWith(OWN_BUNDLE_PREFIX))
const looksLikeBundle = (s: string) => /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(s)

const DELIVERY_WORD: Partial<Record<Delivery, string>> = {
  delivered_verified: '已确认',
  delivered_unverified: '未确认 · 用 snapshot 或 wait_for 核对结果',
  delivered_without_effect: '已送达但没有看到效果 · 不要重复，先 snapshot 确认',
}

const WEB_NEWLINE = '换行会按回车，可能直接发送 · 分开输入，用 click 发送按钮或 submit'

/** M1: web typing cut short after `units` UTF-16 units: the characters typed (the helper counts units) */
const typedChars = (text: string | undefined, units: number): number =>
  text === undefined ? units : Array.from(text.slice(0, units)).length

/** A failed (or uncertain) mutation: code, delivery and retry per spec §8.3. */
function mutationFailure(e: unknown, o: { action?: string; physical?: boolean } = {}): Fail {
  const raw = e instanceof CuDriverError ? e.code : ''
  // forge-cu's act says `unsupported` when the control has none of the chain's actions: that is this control, not the
  // platform (I2); the platform / helper `unsupported` never comes back from an act
  const code: CuErrCode = raw === 'unsupported' && o.action ? 'action_unsupported' : known(raw) ? raw : 'helper_failed'
  const delivery = e instanceof CuDriverError ? e.delivery : undefined
  const retry: Retry = delivery !== undefined ? retryOf(delivery) : NOTHING_SENT.has(code) ? 'safe' : 'unsafe'
  // R8 / I5: forge-cu refused a newline in a web field before posting anything
  let text = code === 'invalid_args' && e instanceof CuDriverError && e.message === 'web_newline' ? WEB_NEWLINE : CU_ERR[code]
  if (delivery) text += ` · delivery=${DELIVERY_SHORT[delivery]}`
  if (retry === 'unsafe' && code !== 'uncertain') text += ' · 可能已经生效 · 不要重复，先重新 snapshot 确认'
  if (retry === 'safe' && code === 'action_unsupported' && !o.physical) {
    if (o.action === 'click') text += ' · 可改用 physical:true'
    else if (o.action === 'type') text += ' · 先 computer_focus 该应用，或用 physical:true 点一下输入框再输入'
  }
  return { ok: false, code, text, ...(delivery ? { delivery } : {}), retry }
}

/** A read failure: retrying a read never repeats an effect. */
const readFailure = (e: unknown): Fail => ({ ...(fromDriverError(e) as Fail), retry: 'safe' })

function boundsCrop(b: { x: number; y: number; w: number; h: number } | undefined, backing: number): { rect: Rect; center: { x: number; y: number } } | null {
  if (!b || ![b.x, b.y, b.w, b.h].every(Number.isFinite) || b.w <= 0 || b.h <= 0) return null
  const k = backing > 0 ? backing : 1
  const w = Math.max(CROP_PHYS_W / k, b.w + 2 * CROP_PAD_PT)
  const h = Math.max(CROP_PHYS_H / k, b.h + 2 * CROP_PAD_PT)
  const center = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  return { rect: { x: center.x - w / 2, y: center.y - h / 2, w, h }, center }
}

/** The short tool-card label: `点击「新建会话」` (spec §10). */
function shortLabel(verb: string, el: { role: string; name?: string }): string {
  return el.name ? `${verb}「${sanitizeScreenText(el.name, 120)}」` : `${verb} ${ROLE_LABEL[el.role] ?? '控件'}`
}

/**
 * One semantic tool call. `core` defaults to the executor core for these deps, so the counters are the ones
 * `createExecutor(d).run` uses.
 */
export async function runSemantic(
  d: ExecutorDeps, key: CuSessionKey, tool: SemanticTool, rawArgs: unknown, core: ExecCore = coreFor(d),
): Promise<CuToolReply> {
  const op = tool.slice('computer_'.length) as CuOp
  const pre = await core.prelude(key, op, rawArgs)
  if ('fail' in pre) return { ...(pre.fail as Fail), retry: 'safe' }
  const { a, st, status } = pre

  const deny = (): CuGuard => ({
    denyPids: [d.ownPid],
    denyBundlePrefixes: [OWN_BUNDLE_PREFIX, ...BLOCKED_BUNDLES, ...d.settings().extraBlocked],
  })
  const classOf = (t: Target, kind: 'act' | 'launch' | 'focus' | 'appKey', combo: ReturnType<typeof parseCombo> | null = null): CuClass =>
    core.classOf(t, kind, combo && !('error' in combo) ? combo : null, false)
  /** R-10: a read of our own app or a blocked app is refused; everything else is read without a gate */
  const readBlock = (t: Target): CuErrCode | null => {
    if (isOwn(d, t)) return 'own_window'
    const c = core.classOf(t, 'act', null, false)
    return c.kind === 'block' ? c.code : null
  }

  async function running(): Promise<Target[] | Fail> {
    try {
      const apps = await d.driver.runningApps()
      return apps.map((x) => ({ pid: x.pid, bundleId: x.bundleId || undefined, name: x.name ?? '' }))
    } catch (e) { return readFailure(e) }
  }
  /** `app` = a bundle id or a name, matched case-insensitively; two apps by that name → ambiguous_target */
  async function findApp(app: string): Promise<Target | Fail | null> {
    const list = await running()
    if (!Array.isArray(list)) return list
    const want = app.trim().toLowerCase()
    const byBundle = list.filter((x) => x.bundleId?.toLowerCase() === want)
    const byName = list.filter((x) => x.name.trim().toLowerCase() === want)
    // any match that is us wins: a name we share with another process is still a request to drive ourselves
    const own = [...byBundle, ...byName].find((x) => isOwn(d, x))
    if (own) return own
    if (byBundle.length === 1) return byBundle[0]
    if (byBundle.length > 1 || byName.length > 1) return safe('ambiguous_target', '同名应用不止一个 · 请改用 bundleId')
    return byName[0] ?? null
  }
  async function target(app: string): Promise<Target | Fail> {
    const t = await findApp(app)
    return t ?? safe('not_found')
  }
  const isFail = (x: unknown): x is Fail => !!x && typeof x === 'object' && (x as { ok?: unknown }).ok === false

  async function spendShot(): Promise<Fail | null> {
    if (st.shotsTurn >= TURN_SHOT_CAP) return safe('step_limit', `本轮截图已达 ${TURN_SHOT_CAP} 张`)
    if (!(await core.pace('shot'))) return safe('rate_limited')
    core.mark('shot')
    st.shotsTurn++
    return null
  }

  // ───────────────────────── reads ─────────────────────────

  async function apps(): Promise<CuToolReply> {
    let list
    try { list = await d.driver.runningApps() } catch (e) { return readFailure(e) }
    const out = list
      .filter((x) => !isOwn(d, { pid: x.pid, bundleId: x.bundleId || undefined }))
      .map((x) => ({ name: wrapUntrusted(x.name || x.bundleId || '未知应用'), bundleId: wrapUntrusted(x.bundleId ?? ''), pid: x.pid, front: !!x.active }))
    return { ok: true, text: JSON.stringify(out) }
  }

  async function windows(): Promise<CuToolReply> {
    let pid: number | undefined
    if (a.app !== undefined) {
      const t = await target(a.app)
      if (isFail(t)) return t
      const b = readBlock(t)
      if (b) return safe(b)
      pid = t.pid
    }
    let r
    try { r = await d.driver.windows(pid !== undefined ? { pid } : {}) } catch (e) { return readFailure(e) }
    const out = r.windows
      .filter((w) => (pid === undefined || w.pid === pid) && !readBlock({ pid: w.pid, bundleId: w.bundleId || undefined, name: w.name ?? '' }))
      .map((w) => ({
        app: wrapUntrusted(w.name || w.bundleId || '未知应用'), bundleId: wrapUntrusted(w.bundleId ?? ''), pid: w.pid,
        window: w.number, title: wrapUntrusted(w.title ?? ''),
      }))
    return { ok: true, text: JSON.stringify(out) }
  }

  async function snapshot(): Promise<CuToolReply> {
    const t = await target(a.app)
    if (isFail(t)) return t
    const b = readBlock(t)
    if (b) return safe(b)
    const spent = await spendShot()
    if (spent) return spent
    let r
    try {
      r = await d.driver.snapshot({
        app: { pid: t.pid }, mode: a.full ? 'full' : 'skeleton', guard: deny(), deadlineMs: SNAPSHOT_DEADLINE_MS,
        ...(a.window !== undefined ? { window: a.window } : {}),
        ...(a.root !== undefined ? { root: a.root } : {}),
        ...(a.depth !== undefined ? { maxDepth: a.depth } : {}),
      })
    } catch (e) { return readFailure(e) }
    // the reply is classified again: a `root` from another app's snapshot must not smuggle that app's tree out
    if (r.instance.pid !== t.pid) return safe('invalid_args', 'root 不属于这个应用')
    const b2 = readBlock({ pid: r.instance.pid, bundleId: r.app.bundleId ?? t.bundleId, name: r.app.name ?? t.name })
    if (b2) return safe(b2)
    return { ok: true, text: `${snapNotice(r.snapId, r.app.name || t.name)}\n${renderSnapshot(r)}` }
  }

  async function waitFor(): Promise<CuToolReply> {
    const t = await target(a.app)
    if (isFail(t)) return t
    const b = readBlock(t)
    if (b) return safe(b)
    const spent = await spendShot()
    if (spent) return spent
    const gone = a.gone === true
    let r
    try {
      r = await d.driver.waitFor({
        pid: t.pid, gone, timeoutMs: a.timeoutMs ?? 5000, guard: deny(),
        match: {
          ...(a.role !== undefined ? { role: a.role } : {}),
          ...(a.name !== undefined ? { name: a.name } : {}),
          ...(a.nameContains !== undefined ? { nameContains: a.nameContains } : {}),
        },
      })
    } catch (e) { return readFailure(e) }
    if (!r.found) return { ok: true, text: gone ? '等待超时 · 控件仍然存在' : '等待超时 · 没有出现' }
    if (gone || !r.node) return { ok: true, text: gone ? '控件已消失' : '已出现' }
    const snapId = r.snapId ?? ''
    return { ok: true, text: `${snapNotice(snapId, t.name)}\n已出现\n${renderNodeLine(r.node, snapId)}` }
  }

  // ───────────────────────── mutations ─────────────────────────

  interface Mutation {
    base: Omit<CuLogEntry, 'ts' | 'turn' | 'result'>
    cls: CuClass
    view: CuActionView
    crop?: () => Promise<string | undefined>
    instance?: Instance
    /** a user at the keyboard / mouse pauses it (T11): physical clicks and focus changes */
    pausesForUser?: boolean
    failOpts?: { action?: string; physical?: boolean }
    call: () => Promise<{ delivery?: Delivery; text: string; label?: string } | Fail>
  }

  /** a refusal before anything ran: it spends a step (T7) and is logged */
  async function refuse(base: Mutation['base'], code: CuErrCode, extra?: string): Promise<Fail> {
    st.inputsTurn++
    await core.record(key, { ...base, result: 'blocked', code })
    return safe(code, extra)
  }

  async function mutate(m: Mutation): Promise<CuToolReply> {
    if (m.cls.kind === 'block') return refuse(m.base, m.cls.code)
    if (m.pausesForUser && d.hidIsPhysical()) {
      const idle = await d.driver.idleSeconds('any').catch(() => Infinity)
      if (idle < IDLE_PAUSE_S) return safe('user_active')
    }

    // approval (spec §7.1 step 4): ask mode, or an ask-always app in any mode
    const ask = m.cls.kind === 'askAlways' ? m.cls : null
    let gated = false
    let thumb: string | undefined
    if (d.svc.modeOf(key) === 'ask' || ask) {
      thumb = m.crop ? await m.crop() : undefined
      const dec = await d.svc.openGate({
        key, kind: 'action', action: m.view, ...(thumb ? { crop: thumb } : {}), ...(ask ? { reason: ask.reason } : {}),
      })
      const denied = gateFailure(dec)
      if (denied) {
        await core.record(key, { ...m.base, result: 'denied', code: denied }, thumb)
        return safe(denied)
      }
      gated = true
    }

    // best effort: semantic actions don't need the foreground, so a failed step-aside doesn't stop them
    await stepAside(d, m.instance)

    if (!(await core.pace('post'))) {
      await core.record(key, { ...m.base, result: 'failed', code: 'rate_limited' }, thumb)
      return safe('rate_limited')
    }
    core.mark('post')
    core.spendInput(st)
    let out: Awaited<ReturnType<Mutation['call']>>
    try { out = await m.call() } catch (e) { out = mutationFailure(e, m.failOpts) }
    core.capCheck(key, st)

    if (!isFail(out) && out.delivery === 'uncertain') out = mutationFailure(new CuDriverError('uncertain', undefined, 'uncertain'))
    else if (!isFail(out) && out.delivery === 'not_delivered') out = mutationFailure(new CuDriverError(m.failOpts?.action ? 'action_unsupported' : 'unsupported', undefined, 'not_delivered'), m.failOpts)
    if (isFail(out)) {
      await core.record(key, { ...m.base, result: out.code === 'blocked_app' || out.code === 'own_window' ? 'blocked' : 'failed', code: out.code, ...(out.delivery ? { delivery: out.delivery } : {}) }, thumb)
      return out
    }
    await core.record(key, { ...m.base, result: gated ? 'allowed' : 'auto', ...(out.delivery ? { delivery: out.delivery } : {}) }, thumb)
    const word = out.delivery ? DELIVERY_WORD[out.delivery] : undefined
    // the `delivery=verified|unverified` tail is forgeMcp's (cuToolResult, spec §8.3), from the structured field
    const text = `${out.text}${word ? ` · ${word}` : ''}`
    return { ok: true, text, ...(out.delivery ? { delivery: out.delivery } : {}), ...(out.label ? { label: out.label } : {}) }
  }

  async function act(): Promise<CuToolReply> {
    const base0: Mutation['base'] = { op: 'act' }
    const limited = await core.stepGate(key, st)
    if (limited) return { ...(limited as Fail), retry: 'safe' }
    let r
    try { r = await d.driver.resolve(a.ref) } catch (e) {
      st.inputsTurn++
      return readFailure(e)
    }
    const element = { role: r.role, ...(r.name !== undefined ? { name: r.name } : {}) }
    const appName = r.appName || r.bundleId || '未知应用'
    const typed: string | undefined = a.action === 'type' ? a.text : a.action === 'set' || a.action === 'select' ? a.value : undefined
    const verb = ACT_LABEL[a.action as keyof typeof ACT_LABEL]
    const base: Mutation['base'] = {
      ...base0, app: appName, ...(r.bundleId ? { bundleId: r.bundleId } : {}), element, actLabel: verb,
      ...(typed !== undefined ? { textLen: Array.from(typed).length } : {}),
    }
    // fail closed: a write needs to know whose element it is
    if (!r.bundleId) return refuse(base, isOwn(d, { pid: r.instance.pid }) ? 'own_window' : 'blocked_app', '无法确认目标应用')
    if ((a.action === 'type' || a.action === 'set') && status.secureInput) return refuse(base, 'secure_input')
    const view: CuActionView = {
      kind: 'act', app: { name: appName, bundleId: r.bundleId }, bundleId: r.bundleId, element, actLabel: verb, ref: a.ref,
      ...(typed !== undefined ? { text: typed } : {}),
      // what makes the same verb mean something else: a physical click, a replace that clears the field, scroll size
      ...(a.physical !== undefined ? { physical: a.physical } : {}),
      ...(a.replace !== undefined ? { replace: a.replace } : {}),
      ...(a.direction !== undefined ? { direction: a.direction } : {}),
      ...(a.amount !== undefined ? { amount: a.amount } : {}),
    }
    const req: ActRequest = { ref: a.ref, action: a.action }
    for (const f of ['value', 'text', 'replace', 'direction', 'amount', 'physical'] as const) {
      if (a[f] !== undefined) (req as unknown as Record<string, unknown>)[f] = a[f]
    }
    const box = boundsCrop(r.bounds, status.display.backing)
    const instance = r.instance
    return mutate({
      base, view, instance,
      cls: classOf({ pid: instance.pid, bundleId: r.bundleId, name: appName }, 'act'),
      pausesForUser: a.physical === true,
      failOpts: { action: a.action, physical: a.physical === true },
      crop: box
        ? async () => {
          try {
            const c = await d.driver.crop({ rectPt: box.rect, marker: [box.center], maskPids: [d.ownPid], maskBundlePrefixes: [OWN_BUNDLE_PREFIX] })
            return c.jpegBase64
          } catch { return undefined }
        }
        : undefined,
      call: async () => {
        const res = await d.driver.act(req, { ...deny(), expectInstance: instance })
        // M1: the focus moved mid-typing: some went in, the rest didn't — never a success, never retried as is
        if (res.delivery === 'uncertain' && typeof res.typed === 'number' && res.typed > 0) {
          return {
            ok: false, code: 'uncertain', delivery: 'uncertain', retry: 'unsafe',
            text: `已输入 ${typedChars(typeof a.text === 'string' ? a.text : undefined, res.typed)} 个字符后焦点变了 · 不要重复，先 snapshot`,
          } satisfies Fail
        }
        // screen text back to the model goes in the untrusted marker (T6); the card uses elementPhrase
        const el = `${ROLE_LABEL[element.role] ?? '控件'}${element.name !== undefined ? ` ${wrapUntrusted(element.name, 120)}` : ''}`
        return { delivery: res.delivery, text: `已${verb} ${el} · 目标 ${wrapUntrusted(appName)}`, label: shortLabel(verb, element) }
      },
    })
  }

  async function launch(): Promise<CuToolReply> {
    const limited = await core.stepGate(key, st)
    if (limited) return { ...(limited as Fail), retry: 'safe' }
    const found = await findApp(a.app)
    if (isFail(found)) { st.inputsTurn++; return found }
    const bundleId = found?.bundleId ?? (looksLikeBundle(a.app) ? a.app : undefined)
    const name = found?.name || a.app
    const base: Mutation['base'] = { op: 'launch', app: name, ...(bundleId ? { bundleId } : {}) }
    const known = isOwn(d, { pid: found?.pid ?? -1, bundleId }) ? { kind: 'block' as const, code: 'own_window' as const }
      : classOf({ pid: found?.pid ?? -1, bundleId, name }, 'launch')
    // a bare name we can't map to a bundle (not running) could be any app, terminals included: it always asks,
    // allow mode too, with the name on the card — forge-cu resolves the name and only checks the deny prefixes
    const cls: CuClass = !bundleId && known.kind === 'normal' ? { kind: 'askAlways', reason: '始终询问' } : known
    return mutate({
      base, cls,
      view: { kind: 'launch', app: { name, bundleId: bundleId ?? '' }, ...(bundleId ? { bundleId } : {}), actLabel: '打开' },
      call: async () => {
        let r
        try {
          r = await d.driver.launch({
            ...(bundleId ? { bundleId } : { name }), activate: a.activate === true, guard: deny(), deadlineMs: LAUNCH_DEADLINE_MS,
          })
        } catch (e) {
          // the guard lists the blocked bundles; forge-cu answers every guard hit with own_window
          if (e instanceof CuDriverError && e.code === 'own_window') return safe('blocked_app')
          throw e
        }
        // launched by name: only now do we know what it was. It is open by now, so the refusal is not a no-op.
        const t = { pid: r.instance.pid, bundleId: r.bundleId, name: r.name }
        const c: CuClass = isOwn(d, t) ? { kind: 'block', code: 'own_window' } : classOf(t, 'launch')
        if (c.kind === 'block') {
          return { ok: false, code: c.code, delivery: 'delivered_unverified', retry: 'unsafe', text: `${CU_ERR[c.code]} · 应用已经被打开 · 不要再打开它` }
        }
        // activate:false leaves the front where it was: if that is still us (the windows hidden, nothing to type
        // into), hand the launched instance to the hider so the front leaves us (spec §9.1). activate:true moved it.
        if (a.activate !== true) await stepAside(d, r.instance)
        const info = {
          pid: r.instance.pid, bundleId: wrapUntrusted(r.bundleId),
          windows: r.windows.map((w) => ({ window: w.number, title: wrapUntrusted(w.title ?? '') })),
        }
        return { text: `已打开 ${wrapUntrusted(r.name || r.bundleId)} · ${JSON.stringify(info)}` }
      },
    })
  }

  async function focus(): Promise<CuToolReply> {
    const limited = await core.stepGate(key, st)
    if (limited) return { ...(limited as Fail), retry: 'safe' }
    const t = await target(a.app)
    if (isFail(t)) { st.inputsTurn++; return t }
    const base: Mutation['base'] = { op: 'focus', app: t.name, ...(t.bundleId ? { bundleId: t.bundleId } : {}) }
    if (!t.bundleId && !isOwn(d, t)) return refuse(base, 'blocked_app', '无法确认目标应用')
    return mutate({
      base, pausesForUser: true,
      cls: isOwn(d, t) ? { kind: 'block', code: 'own_window' } : classOf(t, 'focus'),
      view: { kind: 'focus', app: { name: t.name, bundleId: t.bundleId ?? '' }, ...(t.bundleId ? { bundleId: t.bundleId } : {}), actLabel: '聚焦' },
      call: async () => {
        await d.driver.focusWindow({ pid: t.pid, ...(a.window !== undefined ? { windowNumber: a.window } : {}), guard: deny() })
        return { text: `已切到前台 ${wrapUntrusted(t.name)}` }
      },
    })
  }

  async function appKey(): Promise<CuToolReply> {
    const limited = await core.stepGate(key, st)
    if (limited) return { ...(limited as Fail), retry: 'safe' }
    const c = parseCombo(a.combo)
    if ('error' in c) return safe('invalid_args', c.error)
    const pretty = prettyCombo(c)
    const repeat: number = a.repeat ?? 1
    // M-6: a bare printable key could be part of typed text: the log keeps only that a key was pressed
    const logCombo = c.mods.length > 0 || 'named' in c.key ? pretty : '·'
    if (isBlockedCombo(c)) return refuse({ op: 'key', combo: logCombo }, 'blocked_combo')
    const t = await target(a.app)
    if (isFail(t)) { st.inputsTurn++; return t }
    const base: Mutation['base'] = { op: 'key', app: t.name, ...(t.bundleId ? { bundleId: t.bundleId } : {}), combo: logCombo }
    if (!t.bundleId && !isOwn(d, t)) return refuse(base, 'blocked_app', '无法确认目标应用')
    if (status.secureInput) return refuse(base, 'secure_input')
    return mutate({
      base,
      cls: isOwn(d, t) ? { kind: 'block', code: 'own_window' } : classOf(t, 'appKey', c),
      view: {
        kind: 'appKey', app: { name: t.name, bundleId: t.bundleId ?? '' }, ...(t.bundleId ? { bundleId: t.bundleId } : {}),
        combo: pretty, mods: c.mods, repeat, actLabel: '按键',
      },
      call: async () => {
        const r = await d.driver.appKey({ pid: t.pid, mods: c.mods, key: c.key, repeat, guard: deny() })
        return { delivery: r.delivery, text: `已按 ${pretty}${repeat > 1 ? ` ×${repeat}` : ''} · 目标 ${wrapUntrusted(t.name)} · via=${r.via}` }
      },
    })
  }

  switch (tool) {
    case 'computer_apps': return apps()
    case 'computer_windows': return windows()
    case 'computer_snapshot': return snapshot()
    case 'computer_wait_for': return waitFor()
    case 'computer_act': return act()
    case 'computer_launch': return launch()
    case 'computer_focus': return focus()
    case 'computer_key': return appKey()
  }
}

