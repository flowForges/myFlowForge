import { join } from 'node:path'
import type { CouncilConfig, CouncilSeat, CouncilStage, CouncilState } from '@shared/council'
import type { ChatEvent, ChatMessage } from '@shared/types'
import { Transcript, type Utterance } from './transcript'
import { answerPrompt, critiquePrompt, finalPrompt, followupPrompt, summaryPrompt } from './prompts'
import { councilFileName, parseCouncilResult, renderCouncilMarkdown } from './result'
import type { runSeat, SeatRunDeps } from './seatRunner'
import { logError } from '../log/appLog'

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

type Spoken = { ok: true; text: string } | { ok: false; cancelled: boolean }
/** 主循环的进度游标:暂停 / 换领导者后从这里接着跑。 */
type Phase = 'answer' | 'critique' | 'summary' | 'final'
type Inflight = { cancelled: boolean; cancel(): void }

export class CouncilEngine {
  private st: CouncilState
  private transcript = new Transcript()
  private failures: Record<string, number> = {}
  private dropped: string[] = []
  private materials = ''
  private prepared = false
  private phase: Phase = 'answer'
  // 本轮(第 2 轮起)已经发过言的席位;暂停后继续时跳过他们
  private spokenThisRound: string[] = []
  private pauseRequested = false
  private stopMode: 'finalize' | 'abort' | null = null
  private inflight = new Set<Inflight>()
  private driving = false
  private followingUp = false
  // ★每次继续都 +1,拼进领导者消息 id:暂停前失败的那条已经落盘,继续后重跑同一阶段不能和它撞 id
  private resumes = 0

  constructor(
    private readonly id: string,
    private readonly ws: string,
    private readonly sid: string,
    private cfg: CouncilConfig,
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
    await this.drive()
  }

  // ---- 控制 ----

  /** 当前发言(第 1 轮是当前这一批并行发言)跑完后停住,不打断正在进行的发言(§6.2)。 */
  pause(): void {
    if (this.st.status !== 'running' || this.stopMode) return
    this.pauseRequested = true
  }

  /** 从暂停处接着跑;给了 newLeader 就先换领导者(§7.3:领导者失败暂停后可换人继续)。 */
  async resume(newLeader?: CouncilSeat): Promise<void> {
    // 暂停还没生效(当前发言没跑完)就点了继续:撤销暂停即可
    if (this.st.status === 'running' && this.pauseRequested) {
      this.pauseRequested = false
      return
    }
    if (this.st.status !== 'paused') return
    if (newLeader) {
      this.cfg = { ...this.cfg, leader: newLeader }
      this.st.config = this.cfg
    }
    this.resumes++
    this.st.status = 'running'
    await this.drive()
  }

  /**
   * finalize:立即取消正在进行的发言,让领导者根据已有内容出最终结果;
   * abort:取消一切,不出结果(结束时再点一次「结束」= abort,§6.2)。
   */
  stop(mode: 'finalize' | 'abort'): void {
    const status = this.st.status
    if (status === 'done' || status === 'aborted') return
    if (mode === 'abort') {
      this.stopMode = 'abort'
      this.st.status = 'aborted'
      this.cancelInflight()
      this.changed()
      return
    }
    // ★已经在出最终结果:不能取消领导者,否则 finalize 会把自己打断
    if (this.stopMode === 'finalize' || status === 'finalizing') return
    this.stopMode = 'finalize'
    this.pauseRequested = false
    if (status === 'paused') {
      this.st.status = 'running'
      void this.drive()
      return
    }
    this.cancelInflight()
  }

  /** 插话:立即落盘并进 transcript —— 下一位开始发言时的增量里就有它;正在发言的人这次看不到。 */
  interject(text: string, via?: string): void {
    if (this.st.status !== 'running' || this.stopMode || !this.prepared || !text.trim()) return
    const n = this.count(u => u.stage === 'interject') + 1
    const msg: ChatMessage = {
      id: `${this.id}:interject:${n}`, who: 'user', text, ...(via ? { via } : {}),
      council: { id: this.id, round: this.st.round, stage: 'interject' },
      ts: new Date(this.deps.now()).toISOString(),
    }
    this.deps.append(this.ws, this.sid, msg)
    this.emit({ type: 'user', message: msg })
    this.transcript.add({ seat: 'user', label: '用户', round: this.st.round, stage: 'interject', text })
    this.changed()
  }

  /**
   * 追问(只在 done 之后):全体 = 各席位依次回答,领导者不参与;或只问一个席位。
   * ★不改变结果(§6.5):不碰 councilResult,只把问答追加到 Markdown 的「追问」附录。
   */
  async followup(question: string, target: 'all' | string): Promise<void> {
    if (this.st.status !== 'done') throw new Error(`council ${this.id} is not done`)
    if (this.followingUp) throw new Error(`council ${this.id} is already answering a followup`)
    const seats = target === 'all' ? this.active() : this.cfg.seats.filter(s => s.id === target)
    if (!seats.length) throw new Error(`unknown council seat: ${target}`)
    this.followingUp = true
    try {
      const n = this.count(u => u.stage === 'followup' && u.seat === 'user') + 1
      const round = this.st.round
      const msg: ChatMessage = {
        id: `${this.id}:followup:${n}`, who: 'user', text: question,
        council: { id: this.id, round, stage: 'followup' }, ts: new Date(this.deps.now()).toISOString(),
      }
      this.deps.append(this.ws, this.sid, msg)
      this.emit({ type: 'user', message: msg })
      const q: Utterance = { seat: 'user', label: '用户追问', round, stage: 'followup', text: question }
      this.transcript.add(q)
      this.changed()
      for (const s of seats) {
        // 追问本身单独给,不在增量里重复;前面席位的追问回答在增量里(依次回答)
        const delta = this.transcript.unseenFor(s.id).filter(u => u !== q)
        const r = await this.speak(s, round, 'followup', followupPrompt(question, delta), `:${n}`)
        if (r.ok) this.transcript.add({ seat: s.id, label: s.label, round, stage: 'followup', text: r.text })
      }
      this.writeResult()
      this.changed()
    } finally {
      this.followingUp = false
    }
  }

  /** 记录用户选定的候选(只记录,不触发任何动作),并重写 Markdown。 */
  choose(candidateName: string): void {
    if (this.st.status !== 'done') return
    this.st.chosen = candidateName
    this.writeResult()
    this.changed()
  }

  // ---- 主循环 ----

  private async drive(): Promise<void> {
    if (this.driving) return
    this.driving = true
    try {
      await this.run()
    } catch (e) {
      logError('council', `council ${this.id} stopped on an unexpected error`, e instanceof Error ? (e.stack ?? e.message) : String(e))
      // ★任何依赖意外抛错(取材料、落盘、写文件…)都不能把状态卡在 running/finalizing:
      //  转为暂停并落盘,用户可以继续;start() 本身只 resolve。已经 aborted 的不能被改回暂停。
      this.st.speaking = []
      if (this.st.status === 'running' || this.st.status === 'finalizing') this.halt()
      else this.changed()
    } finally {
      this.driving = false
    }
  }

  private async run(): Promise<void> {
    this.changed()
    if (!this.prepared) {
      this.materials = await this.deps.materialsText(this.cfg)
      if (this.stopMode === 'abort') return
      const topic: ChatMessage = {
        id: `${this.id}:topic`, who: 'user', text: this.cfg.topic,
        files: this.cfg.attachments.length ? this.cfg.attachments : undefined,
        council: { id: this.id, stage: 'topic' }, ts: new Date(this.deps.now()).toISOString(),
      }
      this.deps.append(this.ws, this.sid, topic)
      this.emit({ type: 'user', message: topic })
      this.prepared = true
      this.st.round = 1
      this.changed()
    }

    for (;;) {
      if (this.stopMode === 'abort') return
      if (this.stopMode === 'finalize') this.phase = 'final'
      else if (this.pauseRequested) {
        this.pauseRequested = false
        return this.halt()
      }
      switch (this.phase) {
        case 'answer':
          await this.answerRound()
          this.endRound()
          break
        case 'critique': {
          const next = this.active().find(s => !this.spokenThisRound.includes(s.id))
          if (next) await this.critique(next, this.st.round)
          else this.endRound()
          break
        }
        case 'summary': {
          const r = await this.leaderSummary(this.st.round)
          if (r.ok) this.nextRound()
          else if (!r.cancelled) return this.halt()
          break
        }
        case 'final':
          return this.finalize(this.st.round)
      }
    }
  }

  /** 本轮结束:最后一轮不再总结,由最终结果代替(只有 1 轮 = 各自作答后直接出结果,§5.1);§7.3:讨论方只剩 1 个也直接出结果。 */
  private endRound(): void {
    const rounds = this.cfg.mode.kind === 'rounds' ? this.cfg.mode.rounds : this.cfg.mode.maxRounds
    this.phase = this.st.round >= rounds || this.active().length <= 1 ? 'final' : 'summary'
  }

  private nextRound(): void {
    this.st.round++
    this.spokenThisRound = []
    this.phase = 'critique'
    this.changed()
  }

  // ---- 轮次 ----

  /** 第 1 轮:全部席位并行、各自独立作答(提示词里没有任何别人的内容)。 */
  private async answerRound(): Promise<void> {
    const seats = this.active()
    const results = await Promise.all(seats.map(s => this.speak(s, 1, 'answer', answerPrompt(this.cfg, this.materials, s))))
    // ★结束后再按配置顺序写进 transcript,而不是按完成先后 —— 顺序稳定,后续轮次喂给大家的增量一致
    seats.forEach((s, i) => this.record(s, 1, 'answer', results[i]))
  }

  /** 第 2 轮起:按配置顺序依次发言(一次一位),每人看到上一轮总结 + 本轮在他之前的发言 + 插话。 */
  private async critique(s: CouncilSeat, round: number): Promise<void> {
    const prompt = critiquePrompt(
      this.cfg, s, round, this.transcript.latestSummary(), this.transcript.unseenFor(s.id),
      this.deps.seatResumed(s.id), this.materials,
    )
    const r = await this.speak(s, round, 'critique', prompt)
    this.record(s, round, 'critique', r)
    if (r.ok || !r.cancelled) this.spokenThisRound.push(s.id)
  }

  /** 领导者总结本轮;失败重试一次。 */
  private async leaderSummary(round: number): Promise<Spoken> {
    const items = this.transcript.round(round).filter(u => u.stage !== 'summary')
    const r = await this.leader(round, 'summary', summaryPrompt(this.cfg, round, items))
    if (!r.ok) return r
    this.transcript.add({ seat: this.cfg.leader.id, label: this.cfg.leader.label, round, stage: 'summary', text: r.text })
    this.changed()
    return r
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
    if (this.stopMode === 'abort') return
    if (!r.ok) return this.halt()
    this.transcript.add({ seat: leader.id, label: leader.label, round: lastRound, stage: 'final', text: r.text })
    const path = join(this.ws, '.forge', 'council', councilFileName(this.st.startedAt, this.cfg.topic))
    this.writeResult(path)
    this.st.resultFile = path
    this.st.status = 'done'
    this.changed()
  }

  private halt(): void {
    // 领导者失败等原因先停下时,用户之前点的暂停已经兑现,不能留到继续之后再停一次
    this.pauseRequested = false
    this.st.status = 'paused'
    this.changed()
  }

  // ---- 发言 ----

  /** 领导者发言,失败重试一次(§7.3)。 */
  private async leader(
    round: number, stage: 'summary' | 'final', prompt: string,
    shape?: (text: string) => Pick<ChatMessage, 'text' | 'councilResult'>,
  ): Promise<Spoken> {
    const tag = this.resumes ? `:r${this.resumes}` : ''
    const first = await this.speak(this.cfg.leader, round, stage, prompt, tag, shape)
    // 被「结束」取消的不重试
    if (first.ok || first.cancelled) return first
    // ★重试用不同的消息 id:第一次失败已经以 failed 消息落盘,不能和重试那条撞 id
    return this.speak(this.cfg.leader, round, stage, prompt, `${tag}:retry`, shape)
  }

  /**
   * 跑一次发言:流式转发到 chat:event,结束后落盘一条消息(失败 = stage 'failed' 的空消息)。
   * 被「结束」取消的发言不落盘、不算失败,返回 cancelled。
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
    const handle: Inflight = { cancelled: false, cancel: () => { handle.cancelled = true; run.cancel() } }
    this.inflight.add(handle)
    const r = await run.done
    this.inflight.delete(handle)
    live = false
    this.st.speaking = this.st.speaking.filter(x => x !== seat.id)
    if (!r.ok && handle.cancelled) {
      this.changed()
      return { ok: false, cancelled: true }
    }

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
    return r.ok ? { ok: true, text: r.text } : { ok: false, cancelled: false }
  }

  /** 席位发言结果记进 transcript / 失败计数;连续失败到上限即本场除名。被取消的不算失败。 */
  private record(seat: CouncilSeat, round: number, stage: CouncilStage, r: Spoken): void {
    if (!r.ok && r.cancelled) return
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

  private count(pred: (u: Utterance) => boolean): number {
    return this.transcript.toJSON().items.filter(pred).length
  }

  private cancelInflight(): void {
    for (const h of this.inflight) h.cancel()
  }

  /**
   * 写(或重写)结果 Markdown:结果固定取领导者的最终发言,追问问答作为附录。
   * ★全部从 transcript 推出来,不另存结果 —— 恢复后的引擎也能重写。
   */
  private writeResult(path = this.st.resultFile): void {
    const items = this.transcript.toJSON().items
    const final = items.filter(u => u.stage === 'final').at(-1)
    if (!final || !path) return
    const { result, body } = parseCouncilResult(final.text)
    const followups = items.filter(u => u.stage === 'followup')
    this.deps.writeFile(path, renderCouncilMarkdown(this.state, this.summaries(), result, body, followups))
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
