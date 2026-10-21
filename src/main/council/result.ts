import type { CouncilCandidate, CouncilResult, CouncilState } from '@shared/council'
import { COUNCIL_RESULT_FENCE } from './prompts'
import type { Utterance } from './transcript'

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function normalizeResult(raw: unknown): CouncilResult | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.conclusion !== 'string') return null
  const candidates = arr<Record<string, unknown>>(r.candidates)
    .filter(c => c !== null && typeof c === 'object')
    .map((c): CouncilCandidate => ({
      name: str(c.name),
      points: str(c.points),
      pros: str(c.pros),
      cons: str(c.cons),
      supporters: arr<unknown>(c.supporters).filter((x): x is string => typeof x === 'string'),
      dissenters: arr<Record<string, unknown>>(c.dissenters)
        .filter(d => d !== null && typeof d === 'object')
        .map(d => ({ seat: str(d.seat), reason: str(d.reason) })),
    }))
  const out: CouncilResult = {
    conclusion: r.conclusion,
    candidates,
    disagreements: arr<Record<string, unknown>>(r.disagreements)
      .filter(d => d !== null && typeof d === 'object')
      .map(d => ({ seat: str(d.seat), point: str(d.point), reason: str(d.reason) })),
  }
  const rec = r.recommended as Record<string, unknown> | null | undefined
  if (rec && typeof rec === 'object' && typeof rec.name === 'string') {
    out.recommended = { name: rec.name, reason: str(rec.reason) }
  }
  return out
}

/**
 * 从领导者的最终回答里取出结果围栏。
 * ★按行扫描(开头行 trim 后等于标记即算,同 handoffFence);解析失败一律 result:null 且 body 保持原文,
 *  让界面退回整段 Markdown 显示,不抛错。
 */
export function parseCouncilResult(text: string): { result: CouncilResult | null; body: string } {
  const lines = text.split('\n')
  const open = lines.findIndex(l => l.trim() === COUNCIL_RESULT_FENCE)
  if (open < 0) return { result: null, body: text }
  let close = -1
  for (let i = open + 1; i < lines.length; i++) {
    if (lines[i].trim() === '```') { close = i; break }
  }
  if (close < 0) return { result: null, body: text }
  let result: CouncilResult | null = null
  try {
    result = normalizeResult(JSON.parse(lines.slice(open + 1, close).join('\n')))
  } catch {
    result = null
  }
  if (!result) return { result: null, body: text }
  const body = [...lines.slice(0, open), ...lines.slice(close + 1)].join('\n').trim()
  return { result, body }
}

/** ★先判「不同意」:它包含「同意」二字,顺序反了会误判。允许开头有空白和 Markdown 符号(如 **不同意**)。 */
export function parseVote(text: string): 'agree' | 'disagree' | 'unknown' {
  const head = text.replace(/^[\s*_#>`~\-"'“「【\[(（]+/, '')
  if (head.startsWith('不同意')) return 'disagree'
  if (head.startsWith('同意')) return 'agree'
  return 'unknown'
}

function candidateMd(c: CouncilCandidate, recommended: boolean, chosen: boolean): string[] {
  const out = [`#### ${c.name}${recommended ? ' ★' : ''}${chosen ? ' (已选定)' : ''}`, '']
  if (c.points) out.push(c.points, '')
  if (c.pros) out.push(`- 优点:${c.pros}`)
  if (c.cons) out.push(`- 代价/风险:${c.cons}`)
  if (c.supporters.length) out.push(`- 支持者:${c.supporters.join('、')}`)
  for (const d of c.dissenters) out.push(`- 保留意见(${d.seat}):${d.reason}`)
  out.push('')
  return out
}

export function renderCouncilMarkdown(
  state: CouncilState,
  summaries: Utterance[],
  result: CouncilResult | null,
  fallbackText: string,
  followups: Utterance[],
): string {
  const { config } = state
  const out: string[] = [
    `# AI 共商:${config.topic.trim()}`,
    '',
    '## 讨论方',
    '',
    ...config.seats.map(s => `- ${s.label}`),
    `- 领导者:${config.leader.label}`,
    '',
    '## 最终结果',
    '',
  ]
  if (result) {
    out.push(result.conclusion, '')
    if (result.candidates.length) {
      out.push('### 候选', '')
      for (const c of result.candidates) {
        out.push(...candidateMd(c, result.recommended?.name === c.name, state.chosen === c.name))
      }
    }
    if (result.recommended) out.push('### 推荐', '', `${result.recommended.name}:${result.recommended.reason}`, '')
    if (result.disagreements.length) {
      out.push('### 未解决的分歧', '')
      for (const d of result.disagreements) out.push(`- ${d.seat} · ${d.point}:${d.reason}`)
      out.push('')
    }
  } else {
    out.push(fallbackText, '')
  }
  if (state.chosen) out.push(`**用户选定:${state.chosen}**`, '')
  if (summaries.length) {
    out.push('## 各轮总结', '')
    for (const s of summaries) out.push(`### 第 ${s.round} 轮`, '', s.text, '')
  }
  if (followups.length) {
    out.push('## 追问', '')
    for (const f of followups) out.push(`### ${f.label}`, '', f.text, '')
  }
  return out.join('\n').replace(/\n+$/, '\n')
}

const pad = (n: number) => String(n).padStart(2, '0')

/** ★文件名安全:去掉非法字符与控制符,空白转 `-`,保留 CJK,slug ≤ 40 字符(按码点,不截断代理对)。 */
export function councilFileName(startedAt: number, topic: string): string {
  const d = new Date(startedAt)
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  const slug = Array.from(
    topic
      .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, ''),
  ).slice(0, 40).join('').replace(/[-.]+$/, '')
  return `${stamp}-${slug || 'council'}.md`
}
