import type { AgentProvider } from '../agents/types'
import { getBuiltinProvider } from '@shared/providerCatalog'
import { readSessions } from '../chat/sessionStore'
import { readMessages } from '../chat/chatStore'
import { buildArchiveSummary } from './archiveSummary'

let summarySeq = 0

function oneShot(p: AgentProvider, prompt: string, wsPath: string, env: NodeJS.ProcessEnv): Promise<string> {
  const model = getBuiltinProvider(p.id)?.defaultModels[0]?.id ?? ''
  return new Promise<string>((resolve) => {
    let out = ''
    let settled = false
    const finish = () => { if (!settled) { settled = true; resolve(out) } }
    try {
      const session = p.chat!({ id: `archive-summary-${++summarySeq}`, prompt, model, cwd: wsPath }, {
        onSession: () => {}, onAssistantDelta: (t) => { out += t }, onThinkDelta: () => {},
        onDone: finish, onError: finish,
      }, env)
      session.done.then(finish, finish)
    } catch { finish() }
  })
}

async function pickChatProvider(providers: Record<string, AgentProvider>): Promise<AgentProvider | null> {
  for (const p of Object.values(providers)) {
    if (!p.chat) continue
    try { if (await p.detect()) return p } catch { /* try next */ }
  }
  return null
}

export async function summarizeWorkspace(wsPath: string, providers: Record<string, AgentProvider>, env: NodeJS.ProcessEnv): Promise<string> {
  const recentText = (p: string) => {
    const sf = readSessions(p)
    return sf.sessions.flatMap(s => readMessages(p, s.id)).slice(-12).map(m => `${m.who}: ${m.text}`).join('\n')
  }
  const fallbackTitle = (p: string) => { const sf = readSessions(p); return sf.sessions[sf.sessions.length - 1]?.title ?? '' }
  const provider = await pickChatProvider(providers)
  const summarize = provider ? (prompt: string) => oneShot(provider, prompt, wsPath, env) : null
  return buildArchiveSummary(wsPath, { recentText, fallbackTitle, summarize })
}
