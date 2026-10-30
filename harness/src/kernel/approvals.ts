import { randomUUID } from 'node:crypto'
import type { KernelEvent } from '../protocol/index'
import { nullLogger, type Logger } from './log'

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
  log?: Logger
}

type Pending = { req: ApprovalRequest; settle(decision: ApprovalDecision, by: By): void }

export class Approvals {
  private pending = new Map<string, Pending>()
  private allowed = new Map<string, Set<string>>() // sessionId -> 已 allow_session 的键
  private closed = false
  private log: Logger

  constructor(private opts: ApprovalsOpts) {
    this.log = opts.log ?? nullLogger
  }

  /** 写 requested(或直接结束时的 resolved)失败 → reject(不会同步抛);等待中的结束永不 reject */
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const approvalId = randomUUID()
    if (this.closed || req.signal.aborted) return this.resolved(req, approvalId, 'deny', 'cancel')
    if (req.key !== undefined && this.allowed.get(req.sessionId)?.has(req.key)) {
      return this.resolved(req, approvalId, 'allow', 'session')
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => settle('deny', 'cancel')
      const timer = setTimeout(() => settle('deny', 'timeout'), this.opts.timeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        req.signal.removeEventListener('abort', onAbort)
      }
      // 计时器 / 监听器 / 回调里调用:写事件失败只记日志,不外抛,promise 照样结束
      const settle = (decision: ApprovalDecision, by: By) => {
        if (!this.pending.delete(approvalId)) return
        cleanup()
        try {
          this.resolved(req, approvalId, decision, by)
        } catch (err) {
          this.log.error('approval.resolved append failed', { error: err instanceof Error ? err.message : String(err) })
        }
        resolve(decision)
      }
      // 先登记再写 requested:同步的事件监听者可能在通知里就应答或取消
      this.pending.set(approvalId, { req, settle })
      req.signal.addEventListener('abort', onAbort, { once: true })
      try {
        this.opts.append({
          type: 'approval.requested',
          sessionId: req.sessionId,
          payload: { approvalId, turnId: req.turnId, callId: req.callId, tool: req.tool, summary: req.summary },
        })
      } catch (err) {
        if (this.pending.delete(approvalId)) cleanup()
        reject(err)
      }
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
