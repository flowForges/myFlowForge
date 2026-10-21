import { randomUUID } from 'node:crypto'
import type { AgentProvider, AgentSession, ChatCallbacks, ConfirmDecision, ConfirmReq } from '../agents/types'
import { makeIdleWatchdog } from '../agents/idleWatchdog'
import { readSession, writeSession } from '../chat/chatStore'
import { COUNCIL_TURN_TIMEOUT_MS, type CouncilSeat } from '@shared/council'
import type { Attachment } from '@shared/types'

export type SeatRunDeps = {
  providers: Record<string, AgentProvider>
  env: NodeJS.ProcessEnv
  workspacePath: string
  sessionId: string
  cwd: string
  timeoutMs?: number
}
export type SeatRunCallbacks = {
  onStart(msgId: string): void
  onDelta(msgId: string, text: string): void
  onThink(msgId: string, text: string): void
  onReplace(msgId: string, text: string): void
}
export type SeatRunResult = { ok: true; msgId: string; text: string } | { ok: false; msgId: string; error: string }

// ★席位的会话键与普通对话的 provider 键(如 'claude')互不相交,不会互相覆盖。
export function seatResumeKey(councilId: string, seatId: string): string {
  return `council:${councilId}:${seatId}`
}

// ★共商席位不挂 Forge MCP:MCP 只在 FORGE_SOCKET/FORGE_AGENT_ID/FORGE_MCP_ENTRY 存在时启用,整组 FORGE_* 一起去掉。
function envWithoutForge(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env }
  for (const k of Object.keys(out)) if (k.startsWith('FORGE_')) delete out[k]
  return out
}

export function runSeat(
  councilId: string, seat: CouncilSeat, prompt: string, deps: SeatRunDeps, cb: SeatRunCallbacks,
  /** 议题的附件:提示词里带了议题时由调用方给,和普通对话一样交给 CLI */
  attachments: Attachment[] = [],
): { done: Promise<SeatRunResult>; cancel(): void; resumed: boolean } {
  const msgId = `council-${randomUUID()}`
  const key = seatResumeKey(councilId, seat.id)
  const provider = deps.providers[seat.provider]
  if (!provider?.chat) {
    return { done: Promise.resolve({ ok: false, msgId, error: `provider unavailable: ${seat.provider}` }), cancel() {}, resumed: false }
  }
  const resumeId = readSession(deps.workspacePath, deps.sessionId, key)

  let session: AgentSession | undefined
  let text = ''
  let settled = false
  let resolveDone!: (r: SeatRunResult) => void
  const done = new Promise<SeatRunResult>((res) => { resolveDone = res })
  const cancelSession = () => { try { session?.cancel() } catch { /* 已退出 */ } }
  const finish = (r: SeatRunResult) => {
    if (settled) return
    settled = true
    dog.clear()
    resolveDone(r)
  }
  // ★不传 stall:共商无人值守,静默到点就是终局(取消 + 记失败),不走「先报告」的交互式策略。
  const dog = makeIdleWatchdog(deps.timeoutMs ?? COUNCIL_TURN_TIMEOUT_MS, () => {
    cancelSession()
    finish({ ok: false, msgId, error: 'timeout' })
  })

  const callbacks: ChatCallbacks = {
    onSession(id) { dog.beat(); writeSession(deps.workspacePath, deps.sessionId, key, id) },
    onAssistantDelta(t) { dog.beat(); text += t; cb.onDelta(msgId, t) },
    onAssistantReplace(t) { dog.beat(); text = t; cb.onReplace(msgId, t) },
    onThinkDelta(t) { dog.beat(); cb.onThink(msgId, t) },
    onActivity() { dog.beat() },
    onStatus() { dog.beat() },
    onPhase() { dog.beat() },
    onUsage() { dog.beat() },
    onTurnTokens() { dog.beat() },
    onSubagent() { dog.beat() },
    onToolActivity() { dog.beat() },
    onDone() { finish({ ok: true, msgId, text }) },
    onError(err) { cancelSession(); finish({ ok: false, msgId, error: err.message }) },
    // ★只读:provider 自己确认过是只读的请求才放行,其余一律拒绝;讨论期间不打断用户。
    async onConfirm(req: ConfirmReq): Promise<ConfirmDecision> { dog.beat(); return req.readOnly ? 'allow' : 'deny' },
  }

  cb.onStart(msgId)
  try {
    // ★故意不传 beforeFallback:ACP 握手失败时直接报错,不退回不受控的 run()。
    session = provider.chat(
      { id: msgId, prompt, model: seat.model, cwd: deps.cwd, sessionId: resumeId, permissionMode: 'readonly', attachments },
      callbacks, envWithoutForge(deps.env),
    )
  } catch (e) {
    finish({ ok: false, msgId, error: e instanceof Error ? e.message : String(e) })
  }
  // provider 同步报错时 session 还没赋值,finish 前的 cancelSession 是空操作;这里补一次取消。
  if (settled && session) cancelSession()
  // 进程没发 onDone/onError 就退出(done 先 settle)也要收场。
  void session?.done.then((r) => { if (!settled) finish(r.ok ? { ok: true, msgId, text } : { ok: false, msgId, error: 'exited' }) }, (e) => finish({ ok: false, msgId, error: e instanceof Error ? e.message : String(e) }))

  return { done, cancel() { cancelSession(); finish({ ok: false, msgId, error: 'cancelled' }) }, resumed: resumeId !== undefined }
}
