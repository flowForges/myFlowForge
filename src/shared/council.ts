import type { Attachment } from './types'

/**
 * AI 共商:几个(CLI + 模型)席位围绕同一个议题在一个会话里讨论,主持人收尾。
 * 这里只放双端(main / renderer / mobile)共用的类型、常量和配置校验。
 */

// 可当席位 / 主持人的 CLI。
// ★2026-10-21 真机只读探针(scripts/council-smoke.ts probe):claude / codex / copilot 要求建 PROBE.txt 均被拦住。
//  gemini / qwen 本机未登录,探针跳过;它们的只读是结构性的:ACP 对非读工具的权限请求在 readonly 下一律拒绝
//  (acpProvider)、--approval-mode plan、且不退回 run(),所以保留。
//  qoder / antigravity 的唯一保证是一个未验证的 CLI 参数(--permission-mode default / --mode plan,antigravity 本机也没装),
//  探针通过前不放进来;通过后再加回(`scripts/council-smoke.ts probe qoder`)。
export const COUNCIL_PROVIDERS = ['claude', 'codex', 'gemini', 'qwen', 'copilot'] as const

/** label 形如 "Codex · 6.1",只用于展示。 */
export type CouncilSeat = { id: string; provider: string; model: string; label: string }

export type CouncilMode =
  | { kind: 'rounds'; rounds: number }
  | { kind: 'consensus'; maxRounds: number; maxMinutes: number }

export type CouncilMaterials = {
  projectCwd?: string
  diff?: 'uncommitted' | { range: string }
  files?: string[]
}

export type CouncilConfig = {
  topic: string
  attachments: Attachment[]
  seats: CouncilSeat[]
  leader: CouncilSeat
  mode: CouncilMode
  materials?: CouncilMaterials
  /** 每轮结束后停下等用户(补充 / 继续下一轮);没填 = 开 */
  pauseBetweenRounds?: boolean
}

export type CouncilStage =
  | 'topic' | 'answer' | 'critique' | 'summary'
  | 'consensus-draft' | 'consensus-vote'
  | 'final' | 'followup' | 'interject' | 'failed'

export type CouncilTag = { id: string; seat?: string; round?: number; stage: CouncilStage }

export type CouncilCandidate = {
  name: string
  points: string
  pros: string
  cons: string
  supporters: string[]
  dissenters: { seat: string; reason: string }[]
}

export type CouncilResult = {
  conclusion: string
  candidates: CouncilCandidate[]
  recommended?: { name: string; reason: string }
  disagreements: { seat: string; point: string; reason: string }[]
}

export type CouncilStatus = 'running' | 'paused' | 'finalizing' | 'done' | 'aborted'

export type CouncilState = {
  id: string
  workspacePath: string
  sessionId: string
  status: CouncilStatus
  round: number
  totalRounds: number | null
  speaking: string[]
  startedAt: number
  elapsedMs: number
  chosen?: string
  resultFile?: string
  config: CouncilConfig
  /** 只在「每轮结束后等我」的轮间暂停时为 true;用户暂停 / 领导者失败的暂停不设 */
  waitingForUser?: boolean
}

export const COUNCIL_TURN_TIMEOUT_MS = 300_000
export const COUNCIL_DIFF_CAP_BYTES = 200 * 1024
export const COUNCIL_DEFAULT_ROUNDS = 2
export const COUNCIL_CONSENSUS_CAPS = { maxRounds: 5, maxMinutes: 30 }

const MIN_SEATS = 2
const MAX_SEATS = 6
const MIN_ROUNDS = 1
const MAX_ROUNDS = 5

const TITLE_MAX = 60

/**
 * 议题的一行标题(结果 Markdown 的 H1 等):空白折叠成一个空格,超长按码点截断加「…」。
 * ★议题就是整段输入框文本,多行是常态;直接当 H1 只有第一行进标题,其余行会变成游离的正文 / 标题 / 列表。
 */
export function councilTitle(topic: string): string {
  const one = topic.replace(/\s+/g, ' ').trim()
  const cps = Array.from(one)
  return cps.length > TITLE_MAX ? `${cps.slice(0, TITLE_MAX).join('')}…` : one
}

/** 议题全文的 Markdown 引用块:原文里的 # / - / 1. 都留在引用里,不会冒成文档的结构。 */
export function councilTopicQuote(topic: string): string {
  return topic.trim().split('\n').map(l => (l.trim() ? `> ${l}` : '>')).join('\n')
}

export function isCouncilProvider(id: string): boolean {
  return (COUNCIL_PROVIDERS as readonly string[]).includes(id)
}

/**
 * 校验配置。null = 通过;否则返回短错误码(调用方自行映射成文案)。
 * ★主持人允许和某个席位同 (provider, model):它跑在独立会话里,互不干扰;席位之间则不许重复。
 */
export function validateCouncilConfig(c: CouncilConfig): string | null {
  if (!c.topic || !c.topic.trim()) return 'topic-empty'
  if (c.seats.length < MIN_SEATS) return 'seats-too-few'
  if (c.seats.length > MAX_SEATS) return 'seats-too-many'
  const seen = new Set<string>()
  for (const s of c.seats) {
    if (!isCouncilProvider(s.provider)) return 'seat-provider-invalid'
    const key = `${s.provider}\u0000${s.model}`
    if (seen.has(key)) return 'seat-duplicate'
    seen.add(key)
  }
  if (!c.leader || !isCouncilProvider(c.leader.provider)) return 'leader-invalid'
  // ★续会话按 id 存:领导者和某个席位同 id 就会共用一个会话(界面用 asLeader 区分,这里兜住别的客户端)
  if (c.seats.some(s => s.id === c.leader.id)) return 'leader-id-duplicate'
  if (c.mode.kind === 'rounds') {
    if (!Number.isInteger(c.mode.rounds) || c.mode.rounds < MIN_ROUNDS || c.mode.rounds > MAX_ROUNDS) return 'rounds-invalid'
  } else {
    const { maxRounds, maxMinutes } = c.mode
    if (!Number.isInteger(maxRounds) || maxRounds < MIN_ROUNDS || maxRounds > MAX_ROUNDS) return 'rounds-invalid'
    if (!(maxMinutes > 0) || maxMinutes > COUNCIL_CONSENSUS_CAPS.maxMinutes) return 'minutes-invalid'
  }
  return null
}

// 单次发言的粗略耗时(分钟)区间,只用来给用户一个量级。
const TURN_MIN = 0.5
const TURN_MAX = 2

/**
 * 预计耗时 [低, 高](分钟)。
 * ★第 1 轮各席位并行作答,只算 1 次发言;之后每轮席位依次发言(n 次)。每轮末主持人小结 1 次,
 *  最后主持人收尾 1 次。共识模式按 maxRounds 估上限,并以 maxMinutes 封顶。
 */
export function estimateCouncilMinutes(c: CouncilConfig): [number, number] {
  const n = c.seats.length
  const rounds = c.mode.kind === 'rounds' ? c.mode.rounds : c.mode.maxRounds
  const turns = 1 + Math.max(0, rounds - 1) * n + rounds + 1
  let lo = turns * TURN_MIN
  let hi = turns * TURN_MAX
  if (c.mode.kind === 'consensus') {
    hi = Math.min(hi, c.mode.maxMinutes)
    lo = Math.min(lo, hi)
  }
  return [lo, hi]
}
