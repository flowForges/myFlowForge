import type { CouncilStage } from '@shared/council'

/** label 形如 "Codex · 6.1",由席位 label 带入,用于给发言标注发言者。 */
export type Utterance = { seat: string; label: string; round: number; stage: CouncilStage; text: string }

/**
 * 全场发言记录 + 每个席位「已经看过多少条」。
 * ★只存下标水位而不是副本:items 只增不改,席位的增量 = items.slice(水位)。
 */
export class Transcript {
  private items: Utterance[] = []
  private seen: Record<string, number> = {}

  add(u: Utterance): void {
    this.items.push(u)
  }

  /** 该席位还没看过的发言,返回后立即标记为已看(再调一次为空)。 */
  unseenFor(seatId: string): Utterance[] {
    const from = this.seen[seatId] ?? 0
    this.seen[seatId] = this.items.length
    return this.items.slice(from)
  }

  latestSummary(): Utterance | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].stage === 'summary') return this.items[i]
    }
    return undefined
  }

  round(n: number): Utterance[] {
    return this.items.filter(u => u.round === n)
  }

  toJSON(): { items: Utterance[]; seen: Record<string, number> } {
    return { items: this.items.map(u => ({ ...u })), seen: { ...this.seen } }
  }

  static fromJSON(j: ReturnType<Transcript['toJSON']>): Transcript {
    const t = new Transcript()
    t.items = j.items.map(u => ({ ...u }))
    t.seen = { ...j.seen }
    return t
  }
}
