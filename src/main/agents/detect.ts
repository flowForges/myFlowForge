import { execa } from 'execa'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { AgentProvider } from './types'
import type { ProviderInfo } from '@shared/types'
import { BUILTIN_IDS as CATALOG_BUILTIN_IDS, getBuiltinProvider } from '@shared/providerCatalog'
import { readAgentsConfig, writeAgentsConfig } from '../config/store'
import { refreshProviderModels } from './refreshModels'
import { probeCli, type CliProbe } from './cliVersion'

// Agent CLIs (claude/codex) are Node wrappers whose FIRST `--version` after a cold boot can take
// several seconds (Gatekeeper check + node startup). 5s used to time out → a working CLI got marked
// "not installed" and vanished from the UI. Give the probe room.
const DEFAULT_DETECT_TIMEOUT_MS = 15000
const STALE_TTL_MS = 7 * 24 * 3600 * 1000   // 7 days
const BUILTIN_IDS = new Set(CATALOG_BUILTIN_IDS)

// Resolve a bin name to its absolute path (so the UI can show *where* it was found).
// Already-absolute paths pass through; bare names are looked up on PATH via `which`.
async function resolveBinPath(bin: string | undefined, env: NodeJS.ProcessEnv): Promise<string> {
  if (!bin) return ''
  if (isAbsolute(bin)) return bin
  try { const r = await execa('which', [bin], { env }); return r.stdout.trim() || bin } catch { return bin }
}

// Resolve to `fallback` if the promise neither resolves nor rejects within `ms`.
// A hanging CLI (`<bin> --version` that blocks on a prompt) must never wedge detection.
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise(res => {
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; res(fallback) } }, ms)
    const finish = (v: T) => { if (!settled) { settled = true; clearTimeout(timer); res(v) } }
    p.then(finish, () => finish(fallback))
  })
}

// Definitive presence: an installed CLI whose --version probe merely flaked/timed out must NOT be
// wiped by a force 重新检测. `which`/abs-path is the confident signal; probeCli (ENOENT / non-zero
// exit / timeout) conflates "genuinely absent" with "present but slow/flaky" into one `false`.
async function defaultBinPresent(bin: string | undefined, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!bin) return false
  if (isAbsolute(bin)) return existsSync(bin)
  try { const r = await execa('which', [bin], { env }); return r.exitCode === 0 && r.stdout.trim().length > 0 } catch { return false }
}

export interface DetectOptions {
  timeoutMs?: number
  nowMs?: number
  /** Injectable for tests: called when a background refresh should be scheduled instead of the real refresh. */
  scheduleRefresh?: (providerId: string, providers: Record<string, AgentProvider>, env: NodeJS.ProcessEnv) => void
  broadcast?: () => void
  // When true (the default, i.e. NOT an explicit 重新检测), a provider that was previously detected as
  // installed stays installed even if this probe fails — so a slow/flaky cold-start probe can't wipe a
  // known-good agent. A force detect passes false to honor the probe and clear genuinely-gone CLIs.
  trustPersisted?: boolean
  // Injectable for tests: persist the detection snapshot. Defaults to writing agents.json.
  persist?: (updates: { id: string; installed: boolean; binPath: string; version: string; at: number }[]) => void
  // Injectable for tests: strict "is the bin definitively present" check, distinct from probeCli
  // (which conflates absent/slow/erroring into one `installed:false`). Defaults to a real
  // which/absolute-path-exists check. Only a `false` here lets a force 重新检测 wipe a provider.
  binPresent?: (bin: string | undefined, env: NodeJS.ProcessEnv) => Promise<boolean>
}

export async function detectProviders(
  registry: Record<string, AgentProvider>,
  env: NodeJS.ProcessEnv,
  timeoutMsOrOptions: number | DetectOptions = DEFAULT_DETECT_TIMEOUT_MS,
): Promise<ProviderInfo[]> {
  // Accept either the old `timeoutMs: number` signature or the new options object
  const opts: DetectOptions = typeof timeoutMsOrOptions === 'number'
    ? { timeoutMs: timeoutMsOrOptions }
    : timeoutMsOrOptions
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS
  const nowMs = opts.nowMs ?? Date.now()
  const trustPersisted = opts.trustPersisted ?? true
  const binPresent = opts.binPresent ?? defaultBinPresent

  const agentsCfg = readAgentsConfig()
  const persist = opts.persist ?? defaultPersist

  const defaultSchedule = (providerId: string, providers: Record<string, AgentProvider>, provEnv: NodeJS.ProcessEnv) => {
    void refreshProviderModels(providerId, providers, provEnv).then(() => opts.broadcast?.())
  }
  const scheduleRefresh = opts.scheduleRefresh ?? defaultSchedule

  const NOT_INSTALLED: CliProbe = { installed: false, version: '' }
  const persistUpdates: { id: string; installed: boolean; binPath: string; version: string; at: number }[] = []
  const infos = await Promise.all(Object.values(registry).map(async (p) => {
    const provCfg = agentsCfg.providers.find(c => c.id === p.id)
    // Single `--version` spawn per bin gives both installed + version (all current providers'
    // detect() is exactly `execa(bin, ['--version'])`, and getCliVersion used to re-spawn it).
    // If the probe says "not installed", still fall back to p.detect() so providers with
    // custom detection logic (or bin-less test fakes) keep working.
    const probe = p.bin ? await withTimeout(probeCli(p.bin, env), timeoutMs, NOT_INSTALLED) : NOT_INSTALLED
    const probeInstalled = probe.installed || await withTimeout(p.detect(), timeoutMs, false)
    // Definitive presence check (which/abs-path exists) — distinct from `probeInstalled`, which
    // conflates "genuinely absent" with "present but --version flaked/timed out".
    const present = p.bin ? await withTimeout(binPresent(p.bin, env), timeoutMs, false) : false

    // Sticky detection: keep a previously-detected agent when this probe fails and we're not force-
    // detecting, so a cold-start timeout / transient failure can't make it disappear.
    const wasInstalled = provCfg?.detectedInstalled ?? false
    // present-but-probe-flaked keeps it installed even on force; only a definitively-absent bin clears.
    const installed = probeInstalled || present || (trustPersisted && wasInstalled)

    let binPath: string
    let version: string
    if (probeInstalled) {
      binPath = await resolveBinPath(p.bin, env)
      version = probe.version
      persistUpdates.push({ id: p.id, installed: true, binPath, version, at: nowMs })
    } else if (present && (wasInstalled || installed)) {
      // Bin is definitively there but --version flaked/timed out: refresh the resolved path, keep
      // the last-known version, do NOT wipe (this is the force-reset-safe path).
      binPath = await resolveBinPath(p.bin, env)
      version = provCfg?.detectedVersion ?? ''
      persistUpdates.push({ id: p.id, installed: true, binPath, version, at: nowMs })
    } else if (!trustPersisted && wasInstalled) {
      // Explicit 重新检测 AND the bin is definitively absent → clear the sticky flag (genuinely gone).
      binPath = ''
      version = ''
      persistUpdates.push({ id: p.id, installed: false, binPath, version, at: nowMs })
    } else {
      // Sticky (non-force) carry-forward, or never installed at all.
      binPath = installed ? (provCfg?.detectedBinPath || p.bin || '') : (p.bin ?? '')
      version = installed ? (provCfg?.detectedVersion ?? '') : ''
    }

    let models: { id: string; label: string; description?: string }[] = []
    if (installed) {
      const cachedModels = provCfg?.modelsCache ?? []
      const fetchedAt = provCfg?.modelsFetchedAt ?? 0
      models = cachedModels.length > 0 ? cachedModels : await p.listModels(env).catch(() => [])
      if (p.capabilities.liveModels && (cachedModels.length === 0 || nowMs - fetchedAt > STALE_TTL_MS)) {
        scheduleRefresh(p.id, registry, env)
      }
    }

    const meta = getBuiltinProvider(p.id)
    return {
      id: p.id, displayName: p.displayName, installed, models, bin: p.bin ?? '', binPath,
      custom: !BUILTIN_IDS.has(p.id), liveModels: p.capabilities.liveModels,
      installCmd: meta?.installCmd, authCmd: meta?.authCmd, installHelp: meta?.installHelp,
      ...(version ? { version } : {}),
    }
  }))
  if (persistUpdates.length) persist(persistUpdates)
  return infos
}

// Merge detection snapshots into agents.json (creating provider entries as needed). Only writes when
// something actually changed, to avoid churning the file on every detect.
function defaultPersist(updates: { id: string; installed: boolean; binPath: string; version: string; at: number }[]): void {
  try {
    const cfg = readAgentsConfig()
    let changed = false
    for (const u of updates) {
      let pc = cfg.providers.find(c => c.id === u.id)
      if (!pc) { pc = { id: u.id, binOverride: '', env: {}, modelsCache: [], modelsFetchedAt: 0 }; cfg.providers.push(pc) }
      if (pc.detectedInstalled !== u.installed || pc.detectedVersion !== u.version || pc.detectedBinPath !== u.binPath) {
        pc.detectedInstalled = u.installed; pc.detectedBinPath = u.binPath; pc.detectedVersion = u.version; pc.detectedAt = u.at
        changed = true
      }
    }
    if (changed) writeAgentsConfig(cfg)
  } catch { /* persistence is best-effort */ }
}
