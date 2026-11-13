// The computer-use runtime the desktop host hands out (spec §4.2, §7.3, V3, V12, V16). No electron in here: the shell
// (index.ts) injects the driver factory, the settings store, the chat hooks and the local event sink.
//
// - `host()` is called on every chat turn and every session close (Task 7), so it must stay cheap. The first call
//   builds plain objects (driver handle, probe, log, service); nothing spawns the helper, opens the socket or writes a
//   file until something actually needs it: a status query, an enable, an armed turn.
// - With computer use never provisioned on this machine, nothing here ever starts the helper.
// - The disclaim seam (V3): agent CLIs spawn through `forge-cu exec` once computer use is provisioned AND our helper
//   has answered a status saying it can disclaim. Until a status arrives they spawn as today; enabling is still safe
//   because setMode refuses with restart_required while an undisclaimed agent lives.
import { randomBytes } from 'node:crypto'
import { accessSync, constants, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { GLOBAL_ACTIONS, effectiveBindings } from '@shared/keybindings'
import type { Settings } from '../config/schema'
import type { ComputerUseHost } from '../host/capabilities'
import type { ComputerDriver } from './driver'
import { createActionLog } from './actionLog'
import { cuServiceHandler, type CuHandle } from './cuBridge'
import { executorFactoryFor } from './executor'
import { createPermissionProbe } from './permissions'
import { createComputerUseService, ensurePrivateDir, type ComputerUseService } from './service'
import type { CuEvent, CuSessionKey, StopWhy } from './types'

type CuSettings = Settings['computerUse']

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
/** 16 base32 chars from the OS CSPRNG (the service's token / gate id source). */
export function cuRandom(source: (n: number) => Buffer = randomBytes): string {
  return Array.from(source(16), (b) => B32[b & 31]).join('')
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlain(patch)) return patch
  const out: Record<string, unknown> = isPlain(base) ? { ...base } : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k], v) : v
  }
  return out
}
/** The service's `saveSettings(patch)`: merged into computerUse deeply (never `{computerUse: patch}`, which would wipe
 *  the user's app lists). Arrays replace. */
export function mergeComputerUse(cur: CuSettings, patch: Partial<CuSettings>): CuSettings {
  return deepMerge(cur ?? {}, patch) as CuSettings
}

function isExec(p: string): boolean {
  try { accessSync(p, constants.X_OK); return statSync(p).isFile() } catch { return false }
}
/**
 * Where forge-cu lives (spec §7.3): packaged → `<Resources>/native/forge-cu`; dev → `<repo>/build/native/darwin/forge-cu`
 * (`npm run build:cu-helper`). Not there or not executable → null (`status.helper:'missing'`). The dev root is two up from
 * the bundled `out/main/index.js`.
 */
export function resolveHelperPath(isPackaged: boolean, o: { resourcesPath?: string; devRoot?: string } = {}): string | null {
  const p = isPackaged
    ? join(o.resourcesPath ?? process.resourcesPath, 'native', 'forge-cu')
    : join(o.devRoot ?? join(__dirname, '..', '..'), 'build', 'native', 'darwin', 'forge-cu')
  return isExec(p) ? p : null
}

/** Every accelerator we register globally (after overrides): `computer_key` must never press one (T1 ⑤). */
export function ownAccelerators(overrides: Record<string, string>): string[] {
  const eff = effectiveBindings(overrides)
  return GLOBAL_ACTIONS.map((a) => eff[a.id]).filter((a): a is string => !!a)
}

interface BridgeLike { socketPath: string; configDir: string; close(): Promise<void> }

export interface CuRuntimeDeps {
  platform: NodeJS.Platform
  /** `<SYS_DIR>/computer-use`: the action log root, the cu socket and the per-token MCP configs (0700, V12) */
  dir: string
  ownPid: number
  helperPath: () => string | null
  /** builds the driver handle; must not spawn anything by itself (helperDriver spawns on the first request) */
  makeDriver: () => ComputerDriver
  startBridge: (dir: string, handle: CuHandle) => Promise<BridgeLike>
  openExternal: (url: string) => Promise<void> | void
  /** the local sink only (V2) */
  emit: (e: CuEvent) => void
  note: (key: CuSessionKey, text: string) => void
  /** stops that session's running chat turn (chatQueue.stop) */
  stopTurn: (key: CuSessionKey) => void
  titleOf: (key: CuSessionKey) => string
  readSettings: () => Settings
  writeSettings: (s: Settings) => void
  /** after a save: broadcast settingsChanged so no window writes a stale snapshot back */
  onSettingsSaved?: (s: Settings) => void
  ownAccelerators: () => string[]
  liveAgentChildren: () => { disclaimed: boolean }[]
  /** is Screen Recording granted to this app (in-process check, no helper, no prompt) — the startup latch (I-3) */
  screenGranted?: () => boolean
  /** is Accessibility granted to this app (`isTrustedAccessibilityClient(false)`, no prompt) — the startup latch too (I-1) */
  axGranted?: () => boolean
  /** the helper answered disclaim:false while spawns were disclaimed: reset configureDisclaim's latch (plain spawns) */
  onDisclaimUnavailable?: () => void
  collapseMain?: () => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => string
}

export interface CuRuntime {
  /** undefined off darwin. Cheap: built once, then the same object. */
  host(): ComputerUseHost | undefined
  isBuilt(): boolean
  /** for configureDisclaim({ enabled }); cached, so a spawn never rereads settings (M-8) */
  disclaimEnabled(): boolean
  /** settings changed somewhere: drop the cached provisioned read */
  settingsChanged(): void
  /** before-quit (I-2): every session off and every mcp.cu-*.json gone, synchronously */
  quit(): void
  /** at app start: the grant latch, then (only if provisioned) one helper status for the disclaim check */
  startup(): Promise<void>
  /** powerMonitor lock-screen / suspend / user-did-resign-active / shutdown (V10) */
  onLock(): void
  /** the global stop hotkey: every session (R20) */
  stopAll(): void
  dispose(): Promise<void>
}

export function createCuRuntime(d: CuRuntimeDeps): CuRuntime {
  const now = d.now ?? Date.now
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => { const h = setTimeout(r, ms); h.unref?.() }))
  let built: { host: ComputerUseHost; service: ComputerUseService; driver: ComputerDriver } | null = null
  let bridge: Promise<BridgeLike> | null = null
  let bridgeOpen: BridgeLike | null = null
  /** the last status the helper answered: undefined = never answered */
  let disclaimSeen: boolean | undefined
  let provisionedLatch = false
  /** the last settings read, until settingsChanged() (M-8) */
  let provisionedRead: boolean | null = null
  let unavailableSent = false
  /** the sessions that are on, as of the last `state` event (stop emits it after calling stopTurn) */
  let on = new Set<string>()
  const idOf = (k: CuSessionKey) => JSON.stringify([k.workspacePath, k.sessionId])

  const provisioned = (): boolean => {
    if (provisionedLatch) return true
    if (provisionedRead === null) {
      try { provisionedRead = d.readSettings().computerUse?.provisioned === true } catch { provisionedRead = false }
    }
    if (provisionedRead) provisionedLatch = true
    return provisionedLatch
  }
  const sweepTokenFiles = () => {
    let names: string[] = []
    try { names = readdirSync(d.dir) } catch { return }
    for (const n of names) {
      if (/^mcp\.cu-[^/]*\.json$/.test(n)) { try { rmSync(join(d.dir, n), { force: true }) } catch { /* best effort */ } }
    }
  }

  const saveSettings = (patch: Partial<CuSettings>) => {
    const cur = d.readSettings()
    const next = { ...cur, computerUse: mergeComputerUse(cur.computerUse, patch) } as Settings
    d.writeSettings(next)
    provisionedRead = null
    if (patch.provisioned === true) {
      provisionedLatch = true
      try { ensurePrivateDir(d.dir) } catch { /* the grant latch just won't find it */ }
    }
    try { d.onSettingsSaved?.(d.readSettings()) } catch { /* best effort */ }
  }

  const emit = (e: CuEvent) => {
    if (e.type === 'state') on = new Set(e.sessions.map(idOf))
    d.emit(e)
  }

  const build = () => {
    if (built) return built
    const raw = d.makeDriver()
    // the driver everything here uses: the same handle, its status observed for the disclaim check
    const driver: ComputerDriver = Object.assign(Object.create(null) as ComputerDriver, raw, {
      status: async () => {
        const s = await raw.status()
        disclaimSeen = s.disclaim !== false
        if (!disclaimSeen && !unavailableSent) {
          unavailableSent = true
          try { d.onDisclaimUnavailable?.() } catch { /* best effort */ }
        }
        return s
      },
    })
    const probe = createPermissionProbe({ driver, helperPath: d.helperPath, openExternal: d.openExternal })
    const log = createActionLog(d.dir)
    const settings = () => d.readSettings().computerUse
    const hidIsPhysical = () => false   // V5 / R18: off until 实测 20
    const service = createComputerUseService({
      driver, probe, now, random: d.random ?? (() => cuRandom()),
      emit, note: d.note,
      stopTurn: (k) => { if (on.has(idOf(k))) d.stopTurn(k) },
      titleOf: d.titleOf, settings, ownPid: d.ownPid, ownAccelerators: d.ownAccelerators, log,
      executorFactory: executorFactoryFor({ now, sleep, settings, ownPid: d.ownPid, ownAccelerators: d.ownAccelerators, log, hidIsPhysical }),
      liveAgentChildren: d.liveAgentChildren, hidIsPhysical, saveSettings,
      configDir: () => d.dir,
    })
    const host: ComputerUseHost = {
      service, probe, log,
      bridge: async () => {
        if (!bridge) {
          bridge = d.startBridge(d.dir, cuServiceHandler(service))
          bridge.then((b) => { bridgeOpen = b }, () => { bridge = null })
        }
        const b = await bridge
        return { socketPath: b.socketPath, configDir: b.configDir }
      },
      runningApps: () => driver.runningApps(),
      collapseMain: () => d.collapseMain?.(),
      provision: () => { if (!provisioned()) saveSettings({ provisioned: true }) },
    }
    built = { host, service, driver }
    return built
  }

  return {
    host: () => (d.platform === 'darwin' ? build().host : undefined),
    isBuilt: () => built !== null,
    // I-4: fail closed. Once provisioned, spawns are disclaimed from the first one, before the helper has answered; only
    // an explicit disclaim:false (the SPI is missing) turns that off.
    disclaimEnabled: () => provisioned() && disclaimSeen !== false,
    settingsChanged: () => { provisionedRead = null },

    async startup() {
      if (d.platform !== 'darwin') return
      // V16 ③ / I-3 / I-1: client.json edited to provisioned:false while the app was closed, or a grant given in System
      // Settings without ever enabling. Screen Recording or Accessibility granted to this app (TCC records no user-level
      // process can rewrite) keeps it provisioned on its own.
      if (!provisioned()) {
        const held = (f?: () => boolean) => { try { return f?.() === true } catch { return false } }
        if (held(d.screenGranted) || held(d.axGranted)) saveSettings({ provisioned: true })
      }
      if (!provisioned()) return
      try { await build().host.probe.status() } catch { /* stays plain; enabling re-probes */ }
    },

    onLock() { built?.service.onLock() },
    quit() {
      try { built?.service.stop(undefined, 'quit') } catch { /* exiting anyway */ }
      sweepTokenFiles()
    },
    stopAll() { built?.service.stop(undefined, 'hotkey' satisfies StopWhy) },

    async dispose() {
      if (!built) return
      try { built.driver.dispose() } catch { /* exiting anyway */ }
      const b = bridgeOpen ?? (bridge ? await bridge.catch(() => null) : null)
      await b?.close().catch(() => { /* exiting anyway */ })
    },
  }
}
