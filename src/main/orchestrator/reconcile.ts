import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { wsRunsDir } from '../config/paths'
import { normalizeLoadedRun } from './runStore'
import { readWorkspace, writeWorkspace } from '../config/store'
import { writeJsonAtomic } from '../util/atomicWrite'
import type { RunState } from '@shared/types'

const isTerminal = (s: string) => s === 'ok' || s === 'err'
const DEFAULT_HEARTBEAT_RECONCILE = { stallMs: 90_000, killGraceMs: 60_000 }

export interface RecoverableInput {
  socketAlive: boolean
  lastBeat: number | undefined
  now: number
  cfg: { stallMs: number; killGraceMs: number }
}

/** A dead-app run is recoverable only if its bridge socket is still present AND a heartbeat
 * landed within stall+grace of now — i.e. it was alive moments before the crash. */
export function isRecoverable(i: RecoverableInput): boolean {
  if (!i.socketAlive || i.lastBeat === undefined) return false
  return i.now - i.lastBeat <= i.cfg.stallMs + i.cfg.killGraceMs
}

function latestAgentBeat(run: RunState): number | undefined {
  let latest: number | undefined
  for (const stage of run.stages) {
    for (const agent of stage.agents) {
      if (agent.lastBeat === undefined) continue
      latest = latest === undefined ? agent.lastBeat : Math.max(latest, agent.lastBeat)
    }
  }
  return latest
}

/**
 * Pure: given a loaded run, return the reconciled run if it was non-terminal, else null
 * (no change needed). Non-terminal status/stages/agents → 'err', pending dropped.
 */
export function reconcileRun(run: RunState): RunState | null {
  if (isTerminal(run.status)) return null
  return normalizeLoadedRun(run)
}

/**
 * Scan a workspace's runs; rewrite any non-terminal run's state.json to terminal (err)
 * and sync workspace.json. Also cleans stale sockets left in dead run dirs.
 */
export function reconcileWorkspaceRuns(wsPath: string): void {
  const dir = wsRunsDir(wsPath)

  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      const file = join(dir, entry, 'state.json')
      if (!existsSync(file)) continue

      let run: RunState
      try { run = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }

      const fixed = reconcileRun(run)
      if (!fixed) continue

      const sock = join(dir, entry, 'forge.sock')
      const recoverable = isRecoverable({
        socketAlive: existsSync(sock),
        lastBeat: latestAgentBeat(run),
        now: Date.now(),
        cfg: DEFAULT_HEARTBEAT_RECONCILE,
      })

      // Write directly to the entry's state.json to avoid runId/dirname mismatch
      try { writeJsonAtomic(file, fixed) } catch { /* ignore write errors */ }

      // v1 has no true reattach yet, so the run is still finalized to err above. If a socket
      // exists and the latest beat is recent, leave it in place for future reattach plumbing.
      if (!recoverable) {
        try { if (existsSync(sock)) rmSync(sock, { force: true }) } catch { /* ignore */ }
      }
    }
  }

  // Sync workspace.json status ONLY when it's stuck mid-run ('run'). 'idle' (never ran / cleanly
  // reset) is a benign resting state — must NOT be flipped to 'err' on every boot.
  const ws = readWorkspace(wsPath)
  if (ws && ws.status === 'run') {
    try { writeWorkspace({ ...ws, status: 'err' }) } catch { /* ignore */ }
  }
}

/** Reconcile dead runs across all registered workspaces. Called once at startup. */
export function reconcileDeadRuns(wsPaths: string[]): void {
  for (const p of wsPaths) reconcileWorkspaceRuns(p)
}
