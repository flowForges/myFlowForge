import type { AgentSessionInfo, ChatSession } from '@shared/types'
import type { AgentState } from '../agents/types'
import { getBuiltinProvider } from '@shared/providerCatalog'
import { readSessionAgents } from './chatStore'
import { readRun, readRunAgentSessions } from '../orchestrator/runStore'
import { readSessions } from './sessionStore'

const label = (id: string) => getBuiltinProvider(id)?.displayName ?? id
const mapStatus = (s: AgentState): AgentSessionInfo['status'] => s === 'run' ? 'run' : s === 'ok' ? 'ok' : 'idle'
const hm = (ms?: number) => { if (!ms) return '—'; const d = new Date(ms); const p = (n: number) => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}` }

export function composeAgentSessions(wsPath: string, session: ChatSession): AgentSessionInfo[] {
  if (session.mode === 'workflow' && session.runId) {
    const run = readRun(wsPath, session.runId)
    const captured = readRunAgentSessions(wsPath, session.runId)
    if (!run) return []
    const rows: AgentSessionInfo[] = []
    for (const stage of run.stages) {
      for (const a of stage.agents) {
        const cap = captured[a.id]
        if (!cap) continue
        rows.push({ provider: cap.provider, providerLabel: label(cap.provider), agentName: a.name, role: a.role || stage.name, sessionId: cap.sessionId, status: mapStatus(a.state), lastActiveAt: hm(a.lastBeat) })
      }
    }
    return rows
  }
  const agents = readSessionAgents(wsPath, session.id)
  return Object.entries(agents).map(([prov, sid]) => ({
    provider: prov, providerLabel: label(prov), agentName: '主 Agent', sessionId: sid, status: 'ok', lastActiveAt: '—',
  }))
}

export function agentSessionsForId(wsPath: string, sessionId: string): AgentSessionInfo[] {
  const session = readSessions(wsPath).sessions.find(s => s.id === sessionId)
  return session ? composeAgentSessions(wsPath, session) : []
}
