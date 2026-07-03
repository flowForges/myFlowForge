import { execa } from 'execa'
import { isAbsolute } from 'node:path'
import type { AgentProvider } from './types'
import type { ProviderInfo } from '@shared/types'
import { BUILTIN_IDS as CATALOG_BUILTIN_IDS, getBuiltinProvider } from '@shared/providerCatalog'
import { readAgentsConfig } from '../config/store'
import { refreshProviderModels } from './refreshModels'
import { probeCli, type CliProbe } from './cliVersion'

const DEFAULT_DETECT_TIMEOUT_MS = 5000
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

export interface DetectOptions {
  timeoutMs?: number
  nowMs?: number
  /** Injectable for tests: called when a background refresh should be scheduled instead of the real refresh. */
  scheduleRefresh?: (providerId: string, providers: Record<string, AgentProvider>, env: NodeJS.ProcessEnv) => void
  broadcast?: () => void
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

  const agentsCfg = readAgentsConfig()

  const defaultSchedule = (providerId: string, providers: Record<string, AgentProvider>, provEnv: NodeJS.ProcessEnv) => {
    void refreshProviderModels(providerId, providers, provEnv).then(() => opts.broadcast?.())
  }
  const scheduleRefresh = opts.scheduleRefresh ?? defaultSchedule

  const NOT_INSTALLED: CliProbe = { installed: false, version: '' }
  return Promise.all(Object.values(registry).map(async (p) => {
    // Single `--version` spawn per bin gives both installed + version (all current providers'
    // detect() is exactly `execa(bin, ['--version'])`, and getCliVersion used to re-spawn it).
    // If the probe says "not installed", still fall back to p.detect() so providers with
    // custom detection logic (or bin-less test fakes) keep working.
    const probe = p.bin ? await withTimeout(probeCli(p.bin, env), timeoutMs, NOT_INSTALLED) : NOT_INSTALLED
    const installed = probe.installed || await withTimeout(p.detect(), timeoutMs, false)

    let models: { id: string; label: string; description?: string }[] = []

    if (installed) {
      // Check for a non-empty cache in agents.json
      const provCfg = agentsCfg.providers.find(c => c.id === p.id)
      const cachedModels = provCfg?.modelsCache ?? []
      const fetchedAt = provCfg?.modelsFetchedAt ?? 0

      if (cachedModels.length > 0) {
        // Use cache
        models = cachedModels
      } else {
        // Fall back to static catalog default
        models = await p.listModels(env).catch(() => [])
      }

      // If provider supports liveModels AND (cache is empty OR cache is stale) → schedule background refresh
      if (p.capabilities.liveModels && (cachedModels.length === 0 || nowMs - fetchedAt > STALE_TTL_MS)) {
        scheduleRefresh(p.id, registry, env)
      }
    }

    const binPath = installed ? await resolveBinPath(p.bin, env) : (p.bin ?? '')
    // Detected CLI version (e.g. claude 2.1.x / codex-cli 0.139.0) — shown per agent in settings.
    // Reuses the probe's output instead of spawning `--version` a second time.
    const version = installed ? probe.version : ''
    const meta = getBuiltinProvider(p.id)
    return {
      id: p.id, displayName: p.displayName, installed, models, bin: p.bin ?? '', binPath,
      custom: !BUILTIN_IDS.has(p.id), liveModels: p.capabilities.liveModels,
      installCmd: meta?.installCmd, authCmd: meta?.authCmd, installHelp: meta?.installHelp,
      ...(version ? { version } : {}),
    }
  }))
}
