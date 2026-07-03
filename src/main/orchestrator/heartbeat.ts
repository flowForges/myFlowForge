export interface HeartbeatConfig {
  stallMs: number
  killGraceMs: number
  pingMs: number
}

export type HeartbeatEffect =
  | { agentId: string; kind: 'stall'; silentMs: number }
  | { agentId: string; kind: 'kill'; silentMs: number }

type Phase = 'live' | 'stalled' | 'killed'
interface Tracked { lastBeat: number; awaiting: boolean; phase: Phase }

/**
 * Per-agent liveness tracker with an injected clock. Holds no real timers: callers feed
 * activity via beat()/setAwaiting() and drive checks via tick(); tick() compares the injected
 * now() against thresholds and returns the effects (stall / kill) that should be applied.
 */
export class Heartbeater {
  private agents = new Map<string, Tracked>()

  constructor(private cfg: HeartbeatConfig, private now: () => number) {}

  add(agentId: string): void {
    this.agents.set(agentId, { lastBeat: this.now(), awaiting: false, phase: 'live' })
  }

  remove(agentId: string): void { this.agents.delete(agentId) }

  beat(agentId: string): void {
    const t = this.agents.get(agentId)
    if (!t) return
    t.lastBeat = this.now()
    t.phase = 'live'
  }

  setAwaiting(agentId: string, awaiting: boolean): void {
    const t = this.agents.get(agentId)
    if (!t) return
    t.awaiting = awaiting
    t.lastBeat = this.now()
    if (awaiting) t.phase = 'live'
  }

  lastBeat(agentId: string): number | undefined { return this.agents.get(agentId)?.lastBeat }

  tick(): HeartbeatEffect[] {
    const now = this.now()
    const out: HeartbeatEffect[] = []
    for (const [agentId, t] of this.agents) {
      if (t.awaiting) continue
      const silent = now - t.lastBeat
      if (t.phase === 'live' && silent >= this.cfg.stallMs) {
        t.phase = 'stalled'
        out.push({ agentId, kind: 'stall', silentMs: silent })
      } else if (t.phase === 'stalled' && silent >= this.cfg.stallMs + this.cfg.killGraceMs) {
        t.phase = 'killed'
        out.push({ agentId, kind: 'kill', silentMs: silent })
      }
    }
    return out
  }
}
