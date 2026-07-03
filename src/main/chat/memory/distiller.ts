import { readMessages } from '../chatStore'
import { readSessions, setSessionSummary } from '../sessionStore'
import { readWorkspaceMemory, writeWorkspaceMemory, readSystemMemory, writeSystemMemory, mergeMemory } from './memoryStore'
import { DISTILL_OLDEST_N } from './tokenEstimate'
import type { ChatMessage } from '@shared/types'

// A one-shot LLM call: send a single prompt with no resume/history, return the full reply text.
// Injected by chatService (implemented via provider.chat + haiku). Kept abstract so the distiller
// has no provider dependency and is trivially testable.
export interface DistillDeps { oneShot: (prompt: string, model?: string) => Promise<string> }

const DISTILL_MODEL = 'haiku-4.5'

function renderTranscript(messages: ChatMessage[]): string {
  return messages.map(m => `${m.who === 'user' ? '用户' : '助手'}: ${m.text}`).join('\n')
}

// fail-open wrapper: run fn, swallow any error (never block the chat turn).
async function failOpen(fn: () => Promise<void>): Promise<void> {
  try { await fn() } catch { /* distillation is best-effort; never surface to the chat turn */ }
}

// Conversation-level: summarize the oldest N messages into the session's rolling summary.
export async function distillSession(wsPath: string, sessionId: string, deps: DistillDeps): Promise<void> {
  return failOpen(async () => {
    const messages = readMessages(wsPath, sessionId)
    if (messages.length === 0) return
    const existing = readSessions(wsPath).sessions.find(s => s.id === sessionId)?.summary ?? ''
    const oldest = messages.slice(0, DISTILL_OLDEST_N)
    const prompt = [
      '你是会话记忆蒸馏器。把下面的对话片段压缩成一段简洁的中文摘要,',
      '保留:用户目标、已确定的决策/方案、关键事实;丢弃:寒暄、过程细节。',
      existing ? `已有摘要(基于此增量更新,不要丢失旧要点):\n${existing}\n` : '',
      '对话片段:',
      renderTranscript(oldest),
      '\n只输出摘要正文,不要解释。',
    ].filter(Boolean).join('\n')
    const summary = (await deps.oneShot(prompt, DISTILL_MODEL)).trim()
    if (summary) setSessionSummary(wsPath, sessionId, summary)
  })
}

// Workspace-level: distill durable facts (decisions/conventions/architecture) from the session
// and merge (dedup-by-heading) into <ws>/.forge/memory/workspace.md.
export async function promoteToWorkspace(wsPath: string, sessionId: string, deps: DistillDeps): Promise<void> {
  return failOpen(async () => {
    const messages = readMessages(wsPath, sessionId)
    if (messages.length === 0) return
    const existing = readWorkspaceMemory(wsPath)
    const prompt = [
      '你是 workspace 记忆蒸馏器。从下面对话中提炼**耐久事实**:架构决策、团队约定、技术选型、关键路径。',
      '用 markdown 输出,每条耐久事实归到一个 `## 主题` 小节下(如 `## 架构` / `## 约定` / `## 选型`)。',
      '只输出会长期有效的事实,忽略一次性的临时问答。若无可沉淀的耐久事实,输出空字符串。',
      existing ? `当前已有的 workspace 记忆(用于参考,避免重复;同主题请给出更新后的完整小节):\n${existing}\n` : '',
      '对话:',
      renderTranscript(messages),
    ].filter(Boolean).join('\n')
    const distilled = (await deps.oneShot(prompt, DISTILL_MODEL)).trim()
    if (distilled) writeWorkspaceMemory(wsPath, mergeMemory(existing, distilled))
  })
}

// System-level: low-frequency promotion of cross-workspace user-level prefs/recurring patterns
// from this workspace's memory into ~/.myFlowForge/memory/system.md.
export async function promoteToSystem(wsPath: string, deps: DistillDeps): Promise<void> {
  return failOpen(async () => {
    const wsMem = readWorkspaceMemory(wsPath)
    if (!wsMem.trim()) return
    const existing = readSystemMemory()
    const prompt = [
      '你是系统级记忆蒸馏器。从下面单个 workspace 的记忆中,提炼**跨项目都适用的用户级偏好/复发模式**',
      '(如沟通风格、通用工具链偏好、反复出现的工作方式)。项目专属的细节不要提升。',
      '用 markdown `## 主题` 小节输出;若无跨项目价值,输出空字符串。',
      existing ? `当前系统记忆(避免重复;同主题给更新后的完整小节):\n${existing}\n` : '',
      'workspace 记忆:',
      wsMem,
    ].filter(Boolean).join('\n')
    const distilled = (await deps.oneShot(prompt, DISTILL_MODEL)).trim()
    if (distilled) writeSystemMemory(mergeMemory(existing, distilled))
  })
}
