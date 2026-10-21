import { randomUUID } from 'node:crypto'
import type { CouncilConfig, CouncilState, CouncilStatus } from '@shared/council'
import type { CouncilEngine, PersistedCouncil } from './engine'
import { loadCouncils, saveCouncil } from './store'
import { logError } from '../log/appLog'

// 占着会话的状态:同一会话同一时间只能有一场(§7.2 #9)。暂停中的不占
const LIVE: CouncilStatus[] = ['running', 'finalizing']

export type MakeEngine = (id: string, ws: string, sid: string, cfg: CouncilConfig, restored?: PersistedCouncil) => CouncilEngine

/** 按 councilId 管理引擎;启动时从工作区恢复,退出时全部暂停落盘。 */
export class CouncilRegistry {
  private engines = new Map<string, CouncilEngine>()

  constructor(private readonly makeEngine: MakeEngine) {}

  /** 开一场新的共商(后台跑,不等它结束);该会话已有进行中的 → 抛 'busy'。 */
  start(ws: string, sid: string, cfg: CouncilConfig): string {
    if (this.hasLive(ws, sid)) throw new Error('busy')
    const id = randomUUID()
    const engine = this.makeEngine(id, ws, sid, cfg)
    this.engines.set(id, engine)
    void engine.start()
    return id
  }

  /** 该会话里有没有(除 exceptId 以外)正在运行 / 出结果的共商。 */
  hasLive(ws: string, sid: string, exceptId?: string): boolean {
    return this.forSession(ws, sid).some(e => e.state.id !== exceptId && LIVE.includes(e.state.status))
  }

  get(id: string): CouncilEngine | undefined {
    return this.engines.get(id)
  }

  /** 该会话的全部共商:内存里的 + 只在磁盘上的(还没 restore 的进行中状态按「已暂停」给出)。 */
  listForSession(ws: string, sid: string): CouncilState[] {
    const live = this.forSession(ws, sid).map(e => e.state)
    const known = new Set(live.map(s => s.id))
    const stored = loadCouncils(ws, sid)
      .filter(p => !known.has(p.state.id))
      .map(p => (LIVE.includes(p.state.status) ? { ...p.state, status: 'paused' as const, speaking: [] } : p.state))
    return [...live, ...stored].sort((a, b) => a.startedAt - b.startedAt)
  }

  /**
   * 把工作区里落盘的共商装回内存(已在内存里的跳过)。进行中的转成「已暂停」并立刻落盘,不自动继续(§7.2 #10)。
   * ★已结束的也装回来:重启后还要能追问 / 选定方案。
   */
  restore(ws: string): void {
    for (const p of loadCouncils(ws)) {
      const { id, sessionId, config, status } = p.state
      if (this.engines.has(id)) continue
      // ★逐个兜底:一个状态文件形状不对(构造 / 落盘抛错)只跳过它自己,不能让其余的都恢复不了
      try {
        const engine = this.makeEngine(id, ws, sessionId, config, p)
        this.engines.set(id, engine)
        if (engine.state.status !== status) saveCouncil(ws, engine.snapshot())
      } catch (e) {
        logError('council', `council ${id} could not be restored`, e instanceof Error ? (e.stack ?? e.message) : String(e))
      }
    }
  }

  /** app 退出:取消所有正在进行的发言,全部以「已暂停」落盘(不是 aborted —— 重开后可继续)。 */
  shutdown(): void {
    for (const e of this.engines.values()) e.suspend()
  }

  private forSession(ws: string, sid: string): CouncilEngine[] {
    return [...this.engines.values()].filter(e => e.state.workspacePath === ws && e.state.sessionId === sid)
  }
}
