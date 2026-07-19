import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { wsRunDir, wsRunsDir } from '../config/paths'
import { writeJsonAtomic } from '../util/atomicWrite'
import type { AgentMessage, ArtifactRef } from './types'
import type { RunState, AgentState } from '@shared/types'

export class RunStore {
  private dir: string
  constructor(wsPath: string, runId: string) {
    this.dir = wsRunDir(wsPath, runId)
    mkdirSync(join(this.dir, 'artifacts'), { recursive: true })
  }
  get runDir(): string { return this.dir }
  private contextFile() { return join(this.dir, 'context.json') }
  private messagesFile() { return join(this.dir, 'messages.jsonl') }
  private agentSessionsFile() { return join(this.dir, 'agent-sessions.json') }

  appendMessage(m: AgentMessage) { appendFileSync(this.messagesFile(), JSON.stringify(m) + '\n', 'utf8') }

  private readContext(): Record<string, unknown> {
    if (!existsSync(this.contextFile())) return {}
    try { return JSON.parse(readFileSync(this.contextFile(), 'utf8')) } catch { return {} }
  }
  getContext(key: string): unknown { return this.readContext()[key] }
  private mutateContext(fn: (c: Record<string, unknown>) => void) {
    const c = this.readContext(); fn(c)
    writeJsonAtomic(this.contextFile(), c)   // atomic: a crash mid-write must not corrupt context.json
  }
  setContext(key: string, value: unknown) { this.mutateContext(c => { c[key] = value }) }
  // P-C2/T3 (disk-resume): removes a key entirely (rather than overwriting with some sentinel value)
  // — used by discardResumableRun (persist.ts) to clear a run's saved run2-state so it stops being
  // offered as resumable. No-op if the key was never set.
  deleteContext(key: string) { this.mutateContext(c => { delete c[key] }) }
  writeArtifact(name: string, content: string): ArtifactRef {
    const base = join(this.dir, 'artifacts')
    const p = resolve(base, name)
    const rel = relative(base, p)
    if (isAbsolute(name) || rel === '' || rel.split(sep)[0] === '..') throw new Error(`invalid artifact name: ${name}`)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf8')
    return { path: p, kind: name.split('.').pop() ?? 'file' }
  }

  saveState(run: RunState) {
    writeJsonAtomic(join(this.dir, 'state.json'), run)
  }

  setAgentSession(agentId: string, provider: string, sessionId: string) {
    let map: Record<string, { provider: string; sessionId: string }> = {}
    try {
      if (existsSync(this.agentSessionsFile())) {
        map = JSON.parse(readFileSync(this.agentSessionsFile(), 'utf8'))
      }
    } catch {
      map = {}
    }
    map[agentId] = { provider, sessionId }
    writeJsonAtomic(this.agentSessionsFile(), map)
  }
}

// Snapshot of the most recent run for a workspace, for reattach display.
// Non-terminal states are normalized to 'err' (the process died with the app),
// and pending actions are dropped (no one can resolve a dead run's prompts).
export function readLastRun(wsPath: string): RunState | null {
  const dir = wsRunsDir(wsPath)
  if (!existsSync(dir)) return null
  let best: { mtime: number; file: string } | null = null
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry, 'state.json')
    if (!existsSync(file)) continue
    const mtime = statSync(file).mtimeMs
    if (!best || mtime > best.mtime) best = { mtime, file }
  }
  if (!best) return null
  try {
    return normalizeLoadedRun(JSON.parse(readFileSync(best.file, 'utf8')) as RunState)
  } catch { return null }
}

// '终止退出': delete every persisted run for a workspace so readLastRun returns null — no resume is
// offered and the next workflow starts clean. Best-effort; a missing dir is a no-op.
export function discardRuns(wsPath: string): void {
  const dir = wsRunsDir(wsPath)
  if (!existsSync(dir)) return
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

export function normalizeLoadedRun(run: RunState): RunState {
  const fix = (s: AgentState): AgentState => (s === 'ok' || s === 'err') ? s : 'err'
  return {
    ...run,
    status: fix(run.status),
    pending: [],
    stages: run.stages.map(st => ({
      ...st, state: fix(st.state),
      agents: st.agents.map(a => ({ ...a, state: fix(a.state) })),
    })),
  }
}

export function readRunAgentSessions(wsPath: string, runId: string): Record<string, { provider: string; sessionId: string }> {
  const f = join(wsRunDir(wsPath, runId), 'agent-sessions.json')
  if (!existsSync(f)) return {}
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return {}
  }
}

export function readRun(wsPath: string, runId: string): RunState | null {
  const f = join(wsRunDir(wsPath, runId), 'state.json')
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as RunState
  } catch {
    return null
  }
}
