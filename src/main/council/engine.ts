import { join } from 'node:path'
import type { CouncilConfig, CouncilSeat, CouncilStage, CouncilState } from '@shared/council'
import type { ChatEvent, ChatMessage } from '@shared/types'
import { Transcript, type Utterance } from './transcript'
import { answerPrompt, critiquePrompt, finalPrompt, summaryPrompt } from './prompts'
import { councilFileName, parseCouncilResult, renderCouncilMarkdown } from './result'
import type { runSeat, SeatRunDeps } from './seatRunner'

/** 落盘的共商快照(Task 8 的 store 读写它)。 */
export type PersistedCouncil = {
  state: CouncilState
  transcript: ReturnType<Transcript['toJSON']>
  failures: Record<string, number>
  dropped: string[]
}

export type EngineDeps = {
  runSeat: typeof runSeat
  /** runSeat 需要的进程级依赖;workspacePath / sessionId / cwd 由引擎自己填。 */
  seatDeps: Pick<SeatRunDeps, 'providers' | 'env' | 'timeoutMs'>
  /**
   * 该席位是否已有可续的原生会话(生产里 = readSession(ws, sid, seatResumeKey(id, seatId)) !== undefined)。
   * ★critiquePrompt 要在调用 runSeat **之前**知道 resumed(决定是否重带议题和材料),而 runSeat 只在调用后才返回它。
   */
  seatResumed: (seatId: string) => boolean
  append: (ws: string, sid: string, msg: ChatMessage) => void
  emitChat: (e: ChatEvent) => void
  emitState: (s: CouncilState) => void
  materialsText: (cfg: CouncilConfig) => Promise<string>
  writeFile: (path: string, text: string) => void
  persist: (s: PersistedCouncil) => void
  now: () => number
}

// 连续失败到这个次数,本场不再叫该席位(§7.3)。
const DROP_AFTER_FAILURES = 2

type Spoken = { ok: true; text: string } | { ok: false }

export class CouncilEngine {
  private st: CouncilState
  private transcript = new Transcript()
  private failures: Record<string, number> = {}
  private dropped: string[] = []
  private materials = ''

  constructor(
    private readonly id: string,
    private readonly ws: string,
    private readonly sid: string,
    private readonly cfg: CouncilConfig,
    private readonly deps: EngineDeps,
  ) {
    const totalRounds = cfg.mode.kind === 'rounds' ? cfg.mode.rounds : null
    this.st = {
      id, workspacePath: ws, sessionId: sid, status: 'running', round: 0, totalRounds,
      speaking: [], startedAt: deps.now(), elapsedMs: 0, config: cfg,
    }
  }

  get state(): CouncilState {
    return { ...this.st, speaking: [...this.st.speaking] }
  }

  /** 跑到 done / aborted / paused 为止;从不 reject。 */
  async start(): Promise<void> {
    try {
      await this.run()
    } catch {
      // ★任何依赖意外抛错(取材料、落盘、写文件…)都不能把状态卡在 running/finalizing:
      //  转为暂停并落盘,用户可以继续;start() 本身只 resolve。
      this.st.speaking = []
      this.pause()
    }
  }

  private async run(): Promise<void> {
    this.changed()
    this.materials = await this.deps.materialsText(this.cfg)
    const topic: ChatMessage = {
      id: `${this.id}:topic`, who: 'user', text: this.cfg.topic,
      files: this.cfg.attachments.length ? this.cfg.attachments : undefined,
      council: { id: this.id, stage: 'topic' }, ts: new Date(this.deps.now()).toISOString(),
    }
    this.deps.append(this.ws, this.sid, topic)
    this.emit({ type: 'user', message: topic })

    const rounds = this.cfg.mode.kind === 'rounds' ? this.cfg.mode.rounds : this.cfg.mode.maxRounds
    let last = 0
    for (let round = 1; round <= rounds; round++) {
      this.st.round = round
      this.changed()
      if (round === 1) await this.answerRound()
      else await this.critiqueRound(round)
      last = round
      // ★最后一轮不再总结,由最终结果代替(只有 1 轮 = 各自作答后直接出结果,§5.1)。
      //  §7.3:讨论方只剩 1 个也不再讨论,直接出最终结果
      if (round === rounds || this.active().length <= 1) break
      if (!(await this.leaderSummary(round))) return this.pause()
    }
    await this.finalize(last)
  }

  // ---- 轮次 ----

  /** 第 1 轮:全部席位并行、各自独立作答(提示词里没有任何别人的内容)。 */
  private async answerRound(): Promise<void> {
    const seats = this.active()
    const results = await Promise.all(seats.map(s => this.speak(s, 1, 'answer', answerPrompt(this.cfg, this.materials, s))))
    // ★结束后再按配置顺序写进 transcript,而不是按完成先后 —— 顺序稳定,后续轮次喂给大家的增量一致
    seats.forEach((s, i) => this.record(s, 1, 'answer', results[i]))
  }

  /** 第 2 轮起:按配置顺序依次发言,每人看到上一轮总结 + 本轮在他之前的发言。 */
  private async critiqueRound(round: number): Promise<void> {
    for (const s of this.active()) {
      const prompt = critiquePrompt(
        this.cfg, s, round, this.transcript.latestSummary(), this.transcript.unseenFor(s.id),
        this.deps.seatResumed(s.id), this.materials,
      )
      this.record(s, round, 'critique', await this.speak(s, round, 'critique', prompt))
    }
  }

  /** 领导者总结本轮;失败重试一次。false = 两次都失败。 */
  private async leaderSummary(round: number): Promise<boolean> {
    const items = this.transcript.round(round).filter(u => u.stage !== 'summary')
    const r = await this.leader(round, 'summary', summaryPrompt(this.cfg, round, items))
    if (!r.ok) return false
    this.transcript.add({ seat: this.cfg.leader.id, label: this.cfg.leader.label, round, stage: 'summary', text: r.text })
    this.changed()
    return true
  }

  private async finalize(lastRound: number): Promise<void> {
    this.st.status = 'finalizing'
    this.changed()
    const summaries = this.summaries()
    const lastItems = this.transcript.round(lastRound).filter(u => u.stage !== 'summary')
    const leader = this.cfg.leader
    const r = await this.leader(lastRound, 'final', finalPrompt(this.cfg, summaries, lastItems, []), (text) => {
      const { result, body } = parseCouncilResult(text)
      return { text: body, councilResult: result ?? undefined }
    })
    if (!r.ok) return this.pause()
    this.transcript.add({ seat: leader.id, label: leader.label, round: lastRound, stage: 'final', text: r.text })
    const { result, body } = parseCouncilResult(r.text)
    const path = join(this.ws, '.forge', 'council', councilFileName(this.st.startedAt, this.cfg.topic))
    this.deps.writeFile(path, renderCouncilMarkdown(this.state, summaries, result, body, []))
    this.st.resultFile = path
    this.st.status = 'done'
    this.changed()
  }

  private pause(): void {
    this.st.status = 'paused'
    this.changed()
  }

  // ---- 发言 ----

  /** 领导者发言,失败重试一次(§7.3)。 */
  private async leader(
    round: number, stage: 'summary' | 'final', prompt: string,
    shape?: (text: string) => Pick<ChatMessage, 'text' | 'councilResult'>,
  ): Promise<Spoken> {
    const first = await this.speak(this.cfg.leader, round, stage, prompt, '', shape)
    if (first.ok) return first
    // ★重试用不同的消息 id:第一次失败已经以 failed 消息落盘,不能和重试那条撞 id
    return this.speak(this.cfg.leader, round, stage, prompt, ':retry', shape)
  }

  /**
   * 跑一次发言:流式转发到 chat:event,结束后落盘一条消息(失败 = stage 'failed' 的空消息)。
   * ★消息 id 由引擎按 (轮次, 席位, 阶段) 生成,不用 runSeat 的 msgId:同一次发言的 start/delta/done 共用,
   *  且可预测、可去重。
   */
  private async speak(
    seat: CouncilSeat, round: number, stage: CouncilStage, prompt: string, suffix = '',
    shape?: (text: string) => Pick<ChatMessage, 'text' | 'councilResult'>,
  ): Promise<Spoken> {
    const id = `${this.id}:${round}:${seat.id}:${stage}${suffix}`
    let think = ''
    // ★runSeat 在超时/失败 settle 之后仍可能漏出回调;结果一到就关门,之后的一律丢弃
    let live = true
    this.st.speaking = [...this.st.speaking, seat.id]
    this.changed()
    const run = this.deps.runSeat(this.id, seat, prompt, { ...this.deps.seatDeps, workspacePath: this.ws, sessionId: this.sid, cwd: this.cwd() }, {
      onStart: () => { if (live) this.emit({ type: 'assistant-start', id, model: seat.label }) },
      onDelta: (_m, t) => { if (!live) return; this.emit({ type: 'assistant-delta', id, text: t }) },
      onThink: (_m, t) => { if (!live) return; think += t; this.emit({ type: 'think-delta', id, text: t }) },
      onReplace: (_m, t) => { if (!live) return; this.emit({ type: 'assistant-replace', id, text: t }) },
    })
    const r = await run.done
    live = false
    this.st.speaking = this.st.speaking.filter(x => x !== seat.id)

    const steps = think.split('\n').map(s => s.trim()).filter(Boolean)
    const base: ChatMessage = {
      id, who: 'ai', text: '', provider: seat.provider, model: seat.label,
      council: { id: this.id, seat: seat.id, round, stage: r.ok ? stage : 'failed' },
      ts: new Date(this.deps.now()).toISOString(),
    }
    const msg: ChatMessage = r.ok
      ? { ...base, ...(shape ? shape(r.text) : { text: r.text }), ...(steps.length ? { think: { label: '已思考', steps } } : {}) }
      : base
    this.deps.append(this.ws, this.sid, msg)
    this.emit({ type: 'done', message: msg })
    this.changed()
    return r.ok ? { ok: true, text: r.text } : { ok: false }
  }

  /** 席位发言结果记进 transcript / 失败计数;连续失败到上限即本场除名。 */
  private record(seat: CouncilSeat, round: number, stage: CouncilStage, r: Spoken): void {
    if (r.ok) {
      this.failures[seat.id] = 0
      this.transcript.add({ seat: seat.id, label: seat.label, round, stage, text: r.text })
    } else {
      this.failures[seat.id] = (this.failures[seat.id] ?? 0) + 1
      if (this.failures[seat.id] >= DROP_AFTER_FAILURES && !this.dropped.includes(seat.id)) this.dropped.push(seat.id)
    }
    this.changed()
  }

  // ---- 工具 ----

  private active(): CouncilSeat[] {
    return this.cfg.seats.filter(s => !this.dropped.includes(s.id))
  }

  private summaries(): Utterance[] {
    return this.transcript.toJSON().items.filter(u => u.stage === 'summary')
  }

  // §5.3:选了项目就在项目目录里讨论(可只读翻代码),否则在工作区根目录。
  private cwd(): string {
    return this.cfg.materials?.projectCwd ?? this.ws
  }

  private emit(e: DistributiveOmit<ChatEvent, 'workspacePath' | 'sessionId'>): void {
    this.deps.emitChat({ ...e, workspacePath: this.ws, sessionId: this.sid } as ChatEvent)
  }

  /** 状态有变:刷新用时,广播并落盘。 */
  private changed(): void {
    this.st.elapsedMs = this.deps.now() - this.st.startedAt
    const state = this.state
    this.deps.emitState(state)
    this.deps.persist({ state, transcript: this.transcript.toJSON(), failures: { ...this.failures }, dropped: [...this.dropped] })
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
