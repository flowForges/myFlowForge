import { randomUUID } from 'node:crypto'
import type { KernelEvent } from '../protocol/index'

// 审批(spec §10):ask → approval.requested,等用户应答 / 超时 / 取消 / 内核停止;
// allow_session 把命令键记在本会话内存里,之后同键请求直接放行(不写 requested)

export type ApprovalDecision = 'allow' | 'deny'
type By = 'user' | 'session' | 'timeout' | 'cancel'

export interface ApprovalRequest {
  sessionId: string
  turnId: string
  callId: string
  tool: string
  /** 调用方已打码的摘要(如命令全文),原样写进事件 */
  summary: string
  /** allow_session 的键(lib/tools/commandKey 的 sessionKey);undefined → 永不自动放行 */
  key?: string
  signal: AbortSignal
}

export interface ApprovalsOpts {
  append(e: Omit<KernelEvent, 'seq' | 'ts'>): unknown
  timeoutMs: number
}

type Pending = { req: ApprovalRequest; settle(decision: ApprovalDecision, by: By): void }

export class Approvals {
  private pending = new Map<string, Pending>()
  private allowed = new Map<string, Set<string>>() // sessionId -> 已 allow_session 的键
  private closed = false

  constructor(private opts: ApprovalsOpts) {}

  /** 写事件失败 → reject(不会同步抛) */
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const approvalId = randomUUID()
    if (this.closed || req.signal.aborted) return this.resolved(req, approvalId, 'deny', 'cancel')
    if (req.key !== undefined && this.allowed.get(req.sessionId)?.has(req.key)) {
      return this.resolved(req, approvalId, 'allow', 'session')
    }
    this.opts.append({
      type: 'approval.requested',
      sessionId: req.sessionId,
      payload: { approvalId, turnId: req.turnId, callId: req.callId, tool: req.tool, summary: req.summary },
    })
    return new Promise(resolve => {
      const onAbort = () => settle('deny', 'cancel')
      const timer = setTimeout(() => settle('deny', 'timeout'), this.opts.timeoutMs)
      const settle = (decision: ApprovalDecision, by: By) => {
        if (!this.pending.delete(approvalId)) return
        clearTimeout(timer)
        req.signal.removeEventListener('abort', onAbort)
        try {
          this.resolved(req, approvalId, decision, by)
        } finally {
          resolve(decision)
        }
      }
      this.pending.set(approvalId, { req, settle })
      req.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** 用户应答;未知 / 已结束的 id → false */
  respond(approvalId: string, decision: 'allow' | 'allow_session' | 'deny'): boolean {
    const p = this.pending.get(approvalId)
    if (!p) return false
    if (decision === 'allow_session' && p.req.key !== undefined) {
      const keys = this.allowed.get(p.req.sessionId) ?? new Set<string>()
      keys.add(p.req.key)
      this.allowed.set(p.req.sessionId, keys)
    }
    p.settle(decision === 'deny' ? 'deny' : 'allow', 'user')
    return true
  }

  /** 内核停止:全部待决拒绝(by cancel),之后的请求也直接拒绝 */
  cancelAll(): void {
    this.closed = true
    for (const p of [...this.pending.values()]) p.settle('deny', 'cancel')
  }

  private resolved(req: ApprovalRequest, approvalId: string, decision: ApprovalDecision, by: By): ApprovalDecision {
    this.opts.append({
      type: 'approval.resolved',
      sessionId: req.sessionId,
      payload: { approvalId, turnId: req.turnId, callId: req.callId, decision, by },
    })
    return decision
  }
}
