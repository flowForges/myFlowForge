import { randomUUID } from 'node:crypto'
import { redact } from '../lib/tools/redact'
import type { KernelEvent } from '../protocol/index'
import { APPROVAL_VIA_MAX } from '../protocol/tools'
import { nullLogger, type Logger } from './log'

/**
 * 事件里的 key 只告诉客户端能不能本会话放行。精确匹配的命令整条都是 key:只留开头,这部分 summary 的截断也留着,不会多露东西
 */
const KEY_SHOWN = 200

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
  /** allow_session 的键(lib/tools/commandKey 的 sessionKey,或工具自己给的);undefined → 永不自动放行 */
  key?: string
  /** 这次运行没有隔离(会话级别 none,或工具显式声明):载荷带 unsandboxed,卡片显示 `未隔离` */
  unsandboxed?: boolean
  signal: AbortSignal
}

export interface ApprovalsOpts {
  append(e: Omit<KernelEvent, 'seq' | 'ts'>): unknown
  timeoutMs: number
  log?: Logger
}

type Pending = { req: ApprovalRequest; settle(decision: ApprovalDecision, by: By, via?: string): void }

export class Approvals {
  private pending = new Map<string, Pending>()
  /** sessionId -> allow_session 的键 -> 授予时是否未隔离(在沙箱里授予的键,到无沙箱时不自动放行,review M2) */
  private allowed = new Map<string, Map<string, boolean>>()
  private closed = false
  private log: Logger

  constructor(private opts: ApprovalsOpts) {
    this.log = opts.log ?? nullLogger
  }

  /** 写 requested(或直接结束时的 resolved)失败 → reject(不会同步抛);等待中的结束永不 reject */
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const approvalId = randomUUID()
    if (this.closed || req.signal.aborted) return this.resolved(req, approvalId, 'deny', 'cancel')
    const granted = req.key === undefined ? undefined : this.allowed.get(req.sessionId)?.get(req.key)
    if (granted !== undefined && (granted || req.unsandboxed !== true)) {
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
      const settle = (decision: ApprovalDecision, by: By, via?: string) => {
        if (!this.pending.delete(approvalId)) return
        cleanup()
        try {
          this.resolved(req, approvalId, decision, by, via)
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
          payload: { approvalId, turnId: req.turnId, callId: req.callId, tool: req.tool, summary: req.summary, ...(req.key !== undefined && { key: redact(req.key).slice(0, KEY_SHOWN) }), ...(req.unsandboxed === true && { unsandboxed: true }) },
        })
      } catch (err) {
        if (this.pending.delete(approvalId)) cleanup()
        reject(err)
      }
    })
  }

  /** 用户应答;未知 / 已结束的 id → false。via:渠道插件填,写进 resolved;approval.respond 不传 */
  respond(approvalId: string, decision: 'allow' | 'allow_session' | 'deny', via?: string): boolean {
    const p = this.pending.get(approvalId)
    if (!p) return false
    if (decision === 'allow_session' && p.req.key !== undefined) {
      const keys = this.allowed.get(p.req.sessionId) ?? new Map<string, boolean>()
      // 已在无沙箱下授予过的不降回"仅沙箱"
      keys.set(p.req.key, keys.get(p.req.key) === true || p.req.unsandboxed === true)
      this.allowed.set(p.req.sessionId, keys)
    }
    p.settle(decision === 'deny' ? 'deny' : 'allow', 'user', via?.slice(0, APPROVAL_VIA_MAX))
    return true
  }

  /** 08 §4.1、§4.2:还在等的审批 id,属于这个会话(给了 turnId 就只要这一轮的) */
  pendingIds(sessionId: string, turnId?: string): string[] {
    const out: string[] = []
    for (const [id, p] of this.pending) if (p.req.sessionId === sessionId && (turnId === undefined || p.req.turnId === turnId)) out.push(id)
    return out
  }

  /** 内核停止:全部待决拒绝(by cancel),之后的请求也直接拒绝 */
  cancelAll(): void {
    this.closed = true
    for (const p of [...this.pending.values()]) p.settle('deny', 'cancel')
  }

  private resolved(req: ApprovalRequest, approvalId: string, decision: ApprovalDecision, by: By, via?: string): ApprovalDecision {
    this.opts.append({
      type: 'approval.resolved',
      sessionId: req.sessionId,
      payload: { approvalId, turnId: req.turnId, callId: req.callId, decision, by, ...(via !== undefined && { via }) },
    })
    return decision
  }
}
