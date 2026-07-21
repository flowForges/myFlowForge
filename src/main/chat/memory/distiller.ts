import { readMessages } from '../chatStore'
import { readSessions, setSessionSummary } from '../sessionStore'
import { readWorkspaceMemory, writeWorkspaceMemory, readSystemMemory, writeSystemMemory, mergeMemory } from './memoryStore'
import { DISTILL_OLDEST_N } from './tokenEstimate'
import type { ChatMessage } from '@shared/types'

// A one-shot LLM call: send a single prompt with no resume/history, return the full reply text.
// Injected by chatService, which picks a distill model VALID FOR THE SESSION'S PROVIDER (see
// distillModelFor) — the distiller stays provider-agnostic and must NOT hardcode a model id, or a
// claude-only alias like 'haiku-4.5' would 400 on codex/cursor sessions.
export interface DistillDeps { oneShot: (prompt: string) => Promise<string> }

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
    const summary = (await deps.oneShot(prompt)).trim()
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
      '你是 workspace 记忆蒸馏器。从下面对话中提炼**耐久事实**:项目做什么、项目之间关系、建区目的、架构决策、团队约定、技术选型、关键路径。',
      '用 markdown 输出,每条耐久事实归到一个 `## 主题` 小节下。有内容时优先覆盖这些主题:',
      '`## 项目`(每个项目一行「做什么」)、`## 项目关系`(项目间依赖/协作)、`## 建区目的`(用户为何建此工作区、想达成什么)、`## 架构`、`## 约定`、`## 选型`。',
      '只输出会长期有效的事实,忽略一次性的临时问答。某主题没内容就不写该小节。若无可沉淀的耐久事实,输出空字符串。',
      // 对话文本里混入了 AI 执行过程的日志/命令输出(见 chatService onLog),这些不是耐久事实,必须排除。
      '**绝对不要**记录:具体命令及其输出、执行/构建/测试日志、报错信息、失败或成功的命令记录、文件 diff、工具调用的中间结果——这些是一次性过程噪音,不是记忆。只记录从中体现出的**结论性决策/约定/意图**。',
      existing ? `当前已有的 workspace 记忆(用于参考,避免重复;同主题请给出更新后的完整小节):\n${existing}\n` : '',
      '对话:',
      renderTranscript(messages),
    ].filter(Boolean).join('\n')
    const distilled = (await deps.oneShot(prompt)).trim()
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
      '你是系统级记忆蒸馏器。从下面单个 workspace 的记忆中,提炼**跨项目都适用的用户级偏好/复发模式**。项目专属的细节不要提升。',
      '用 markdown `## 主题` 小节输出,有内容时覆盖:',
      '`## 用户习惯`(沟通风格、工作方式、通用工具链偏好)、`## 常用能力`(反复出现的项目核心功能/需求模式)。',
      '某主题没内容就不写该小节;若无跨项目价值,输出空字符串。',
      '**绝对不要**记录:具体命令及其输出、执行/构建/测试日志、报错、失败或成功的命令记录、任何一次性执行细节——系统记忆只放跨项目的用户偏好与复发模式。',
      existing ? `当前系统记忆(避免重复;同主题给更新后的完整小节):\n${existing}\n` : '',
      'workspace 记忆:',
      wsMem,
    ].filter(Boolean).join('\n')
    const distilled = (await deps.oneShot(prompt)).trim()
    if (distilled) writeSystemMemory(mergeMemory(existing, distilled))
  })
}
