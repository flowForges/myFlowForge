// 确认收件箱(06 spec §14):USER.md 只有这一条路,MEMORY.md 过不了门槛的也走这里。
// memory.proposal 不带 sessionId,也不带文本:收件箱是用户的,不属于哪个会话,所以不进任何会话的历史,不顶 updatedAt
import { randomBytes } from 'node:crypto'
import { RpcError } from '../../kernel/rpcError'
import { scanInjection } from '../../lib/memory/scan'
import { cleanText } from '../../lib/tools/diagnostics'
import type { KernelEvent, MemoryProposalPayload } from '../../protocol/events'
import type { MemoryProposal } from '../../protocol/rpc'
import { cleanEntry, type MemoryFiles } from './files'
import type { Store } from './store'

const INVALID_PARAMS = -32602
const MAX_PENDING = 50
const LIST_MAX = 200
export const PROPOSAL_TTL_MS = 30 * 86_400_000
const RAW_ID = /^r_([1-9]\d{0,15})$/

type Target = MemoryProposal['target']
type Status = MemoryProposal['status']

export interface ProposalInput {
  target: Target
  op: MemoryProposal['op']
  text: string
  replaces?: string
  evidence?: string[]
  source: MemoryProposal['source']
  flags?: string[]
  /** memory_write 建的:这一轮回滚,提议跟着没 */
  turnId?: string
}

export type CreateResult = { id: string; deduped?: true } | { refused: 'too_many' | 'empty' }

export interface ProposalsDeps {
  store: Store
  files: Pick<MemoryFiles, 'addEntry' | 'supersede' | 'assertFits' | 'removeCandidateLines'>
  now(): number
  append(e: Omit<KernelEvent, 'seq' | 'ts'>): unknown
}

interface Row {
  id: string
  target: Target
  op: MemoryProposal['op']
  text: string
  replaces: string | null
  evidence: string
  source: MemoryProposal['source']
  flags: string
  status: Status
  created_at: number
  decided_at: number | null
}

const toProposal = (r: Row): MemoryProposal => ({
  id: r.id,
  target: r.target,
  op: r.op,
  text: r.text,
  ...(r.replaces !== null && { replaces: r.replaces }),
  evidence: JSON.parse(r.evidence) as string[],
  source: r.source,
  flags: JSON.parse(r.flags) as string[],
  status: r.status,
  createdAt: r.created_at,
  ...(r.decided_at !== null && { decidedAt: r.decided_at }),
})

/** 比较用:同一句话换个标点、大小写、空格还是同一句 */
export function normalize(text: string): string {
  const lowered = cleanText(text).toLowerCase()
  const bare = lowered.replace(/[\s\p{P}]+/gu, '')
  return bare === '' ? lowered.trim() : bare
}

/** 这条证据现在还算不算用户自己的话。回滚的、删掉的、别的范围的都不算 */
export function liveEvidence(store: Pick<Store, 'getRaw'>, id: string) {
  const seq = RAW_ID.exec(id)?.[1]
  const row = seq === undefined ? undefined : store.getRaw(Number(seq))
  return row && !row.rolledBack && row.role === 'user' && row.scope === 'owner' && (row.origin === 'app' || row.origin === 'im') ? row : undefined
}

export class Proposals {
  constructor(private readonly d: ProposalsDeps) {}

  pending(): number {
    return (this.d.store.db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'").get() as { n: number }).n
  }

  /** 打码、按归一化文本去重。提取不再问用户拒绝过的;用户让模型记的可以再问 */
  create(p: ProposalInput): CreateResult {
    const clean = cleanEntry(p.text)
    if (clean.text === '') return { refused: 'empty' }
    const statuses = p.source === 'extract' ? "('pending', 'rejected')" : "('pending')"
    const norm = normalize(clean.text)
    const rows = this.d.store.db.prepare(`SELECT id, text FROM proposals WHERE status IN ${statuses}`).all() as { id: string; text: string }[]
    const same = rows.find(r => normalize(r.text) === norm)
    if (same) return { id: same.id, deduped: true }
    if (this.pending() >= MAX_PENDING) return { refused: 'too_many' }
    const id = `p_${randomBytes(6).toString('hex')}`
    const flags = [...new Set([...(p.flags ?? []), ...scanInjection(clean.text)])]
    this.d.store.db
      .prepare("INSERT INTO proposals(id, target, op, text, replaces, evidence, source, flags, status, turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
      .run(id, p.target, p.op, clean.text, p.replaces ?? null, JSON.stringify(p.evidence ?? []), p.source, JSON.stringify(flags), p.turnId ?? null, this.d.now())
    this.notify({ id, target: p.target, status: 'pending' })
    return { id }
  }

  /** 新的在前 */
  list(status?: Status): MemoryProposal[] {
    const rows = status
      ? this.d.store.db.prepare('SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC, id LIMIT ?').all(status, LIST_MAX)
      : this.d.store.db.prepare('SELECT * FROM proposals ORDER BY created_at DESC, id LIMIT ?').all(LIST_MAX)
    return (rows as unknown as Row[]).map(toProposal)
  }

  /**
   * 调用方先让接入追上:否则刚发生的回滚和删除还没算进证据。
   * 写文件在改状态之前,而且 id 由提议定:中途崩溃还是 pending,重试不会多一行
   */
  decide(id: string, decision: 'approve' | 'reject', text?: string): void {
    const row = this.d.store.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as Row | undefined
    if (!row || row.status !== 'pending') throw new RpcError(INVALID_PARAMS, 'not found')
    if (decision === 'reject') {
      this.retire(row, 'rejected')
      return
    }
    if (!this.backed(row)) {
      this.retire(row, 'expired')
      throw new RpcError(INVALID_PARAMS, 'expired')
    }
    const clean = cleanEntry(text ?? row.text)
    if (clean.text === '') throw new RpcError(INVALID_PARAMS, 'empty')
    const entryId = `n_${row.id.replace(/^p_/, '')}`
    const candidate = this.candidateOf(row.text)
    const replaced = row.op === 'replace' && row.replaces !== null ? row.replaces : undefined
    // 放不下要在挪走旧行之前知道;旧行腾出来的地方算数
    this.d.files.assertFits(row.target, clean.text, replaced)
    if (replaced !== undefined) this.d.files.supersede(replaced, entryId)
    this.d.files.addEntry(row.target, clean.text, {
      id: entryId,
      src: 'confirmed',
      ts: this.d.now(),
      evidence: JSON.parse(row.evidence) as string[],
      ...(candidate !== undefined && { candidate }),
    })
    this.setStatus(row, 'approved')
  }

  /** 到 30 天没人理的 */
  expire(now: number): number {
    const rows = this.d.store.db.prepare("SELECT * FROM proposals WHERE status = 'pending' AND created_at <= ?").all(now - PROPOSAL_TTL_MS) as unknown as Row[]
    for (const row of rows) this.retire(row, 'expired')
    return rows.length
  }

  /** 证据全没了的(回滚、删除)。模型建的本来就没有证据,不在此列 */
  expireUnbacked(): number {
    const rows = this.d.store.db.prepare("SELECT * FROM proposals WHERE status = 'pending'").all() as unknown as Row[]
    const gone = rows.filter(r => !this.backed(r))
    for (const row of gone) this.retire(row, 'expired')
    return gone.length
  }

  private backed(row: Row): boolean {
    const evidence = JSON.parse(row.evidence) as string[]
    return evidence.length === 0 || evidence.some(e => liveEvidence(this.d.store, e))
  }

  private candidateOf(text: string): string | undefined {
    return (this.d.store.db.prepare('SELECT id FROM candidates WHERE text = ?').get(text) as { id: string } | undefined)?.id
  }

  /** 结束了:对应的候选和它的草稿行也不留。同样的话以后再说,要重新攒够两天 */
  private retire(row: Row, status: 'rejected' | 'expired'): void {
    const candidate = this.candidateOf(row.text)
    if (candidate !== undefined) {
      this.d.files.removeCandidateLines([candidate])
      this.d.store.db.prepare('DELETE FROM candidates WHERE id = ?').run(candidate)
    }
    this.setStatus(row, status)
  }

  private setStatus(row: Row, status: Status): void {
    this.d.store.db.prepare('UPDATE proposals SET status = ?, decided_at = ? WHERE id = ?').run(status, this.d.now(), row.id)
    this.notify({ id: row.id, target: row.target, status })
  }

  private notify(payload: MemoryProposalPayload): void {
    this.d.append({ type: 'memory.proposal', payload })
  }
}
