import { readWorkspaceMemory, readSystemMemory } from './memoryStore'
import { readSessions } from '../sessionStore'

export interface PreambleOpts {
  // True only when CLI --resume context is gapped (new session / first turn / resume id missing),
  // in which case the rolling session summary is injected to bridge the gap. Normally false:
  // --resume natively carries conversation history, so injecting the summary would be redundant.
  resumeGapped: boolean
}

// Assemble the memory preamble in the spec order: system.md + workspace.md + [session summary
// only when resume is gapped]. Returns '' when nothing to inject.
export function buildMemoryPreamble(wsPath: string, sessionId: string, opts: PreambleOpts): string {
  const blocks: string[] = []
  const sys = readSystemMemory().trim()
  if (sys) blocks.push(`## 系统记忆\n${sys}`)
  const wsMem = readWorkspaceMemory(wsPath).trim()
  if (wsMem) blocks.push(`## Workspace 记忆\n${wsMem}`)
  if (opts.resumeGapped) {
    const summary = readSessions(wsPath).sessions.find(s => s.id === sessionId)?.summary?.trim()
    if (summary) blocks.push(`## 本会话摘要\n${summary}`)
  }
  if (blocks.length === 0) return ''
  return `# 记忆上下文(供参考,不要复述)\n\n${blocks.join('\n\n')}\n`
}
