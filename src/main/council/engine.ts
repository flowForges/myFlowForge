import { join } from 'node:path'
import type { CouncilConfig, CouncilSeat, CouncilStage, CouncilState } from '@shared/council'
import type { Attachment, ChatEvent, ChatMessage } from '@shared/types'
import { Transcript, type Utterance } from './transcript'
import {
  answerPrompt, consensusDraftPrompt, consensusVotePrompt, critiquePrompt, finalPrompt, followupPrompt, summaryPrompt,
} from './prompts'
import { councilFileName, parseCouncilResult, parseVote, renderCouncilMarkdown } from './result'
import type { runSeat, SeatRunDeps } from './seatRunner'
import { logError } from '../log/appLog'

/** 主循环的进度游标:暂停 / 换领导者 / 重启后从这里接着跑。 */
export type CouncilPhase = 'answer' | 'critique' | 'summary' | 'consensus-draft' | 'consensus-vote' | 'final'

/** 落盘的共商快照(store 读写它);restored 引擎从它接着跑。 */
export type PersistedCouncil = {
  state: CouncilState
  transcript: ReturnType<Transcript['toJSON']>
  failures: Record<string, number>
  dropped: string[]
  phase: CouncilPhase
  spokenThisRound: string[]
  /** 领导者消息 id 的继续次数后缀;重启后接着这个数往上加,不和重启前的 id 撞 */
  resumes: number
  /** 累计停着的时长(轮间等用户 + 用户暂停 + 失败暂停),共识模式的时间上限不算它;老快照没有 = 0 */
  pausedMs?: number
  /** 这次停下的时刻;没停 = 不填 */
  pausedSince?: number
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
  /** 读会话已落盘的消息(生产里 = chatStore.readMessages);只在恢复时读一次,用来跳过崩溃前已经写进会话的发言。 */
  readMessages: (ws: string, sid: string) => ChatMessage[]
  emitChat: (e: ChatEvent) => void
  emitState: (s: CouncilState) => void
  materialsText: (cfg: CouncilConfig) => Promise<string>
  writeFile: (path: string, text: string) => void
  persist: (s: PersistedCouncil) => void
  now: () => number
}

// 连续失败到这个次数,本场不再叫该席位(§7.3)。
const DROP_AFTER_FAILURES = 2
/** 思考用时(秒,至少 1):从第一段思考到落盘。渲染端「思考」折叠块的秒数就是它。 */
const thinkElapsed = (since: number, now: number) => Math.max(1, Math.round((now - since) / 1000))

type Spoken = { ok: true; text: string } | { ok: false; cancelled: boolean }
type Inflight = { cancelled: boolean; cancel(): void }
type Shape = (text: string) => Pick<ChatMessage, 'text' | 'councilResult'>
type SpeakOpts = {
  /** 拼在消息 id 后面(领导者的继续 / 重试、第几次追问),避免和已落盘的撞 id */
  suffix?: string
  shape?: Shape
  /** 提示词里带了议题时,议题的附件一并交给 CLI(§5.3:附件和普通对话一致) */
  attachments?: Attachment[]
}

export class CouncilEngine {
  private st: CouncilState
  private transcript = new Transcript()
  private failures: Record<string, number> = {}
  private dropped: string[] = []
  private materials = ''
  private materialsLoaded = false
  private prepared = false
  private phase: CouncilPhase = 'answer'
  // 本轮(第 2 轮起)已经发过言的席位;暂停后继续时跳过他们
  private spokenThisRound: string[] = []
  private pauseRequested = false
  private stopMode: 'finalize' | 'abort' | null = null
  private inflight = new Set<Inflight>()
  private driving = false
  private redrive = false
  private followingUp = false
  // ★每次继续都 +1,拼进领导者消息 id:暂停前失败的那条已经落盘,继续后重跑同一阶段不能和它撞 id
  private resumes = 0
  // ★共识的时间上限只算讨论真正在跑的时间:停着等用户(轮间 / 暂停)的时间累计在这里,判上限时扣掉
  private pausedMs = 0
  private pausedSince: number | null = null
  // app 退出时被挂起:正在收尾的这次 run 不能再推进游标或记账(见 suspend())
  private suspended = false
  // ★已经写进会话、却还没进 transcript 的发言(第 1 轮 / 投票是整批结束才记账;崩溃或挂起时整批作废),按消息 id 索引。
  //  重跑到同一个 id 时直接取它的结果,不再叫席位、也不再落盘 —— 会话里不会出现重复消息
  private replay = new Map<string, Spoken>()

  constructor(
    private readonly id: string,
    private readonly ws: string,
    private readonly sid: string,
    private cfg: CouncilConfig,
    private readonly deps: EngineDeps,
    restored?: PersistedCouncil,
  ) {
    const totalRounds = cfg.mode.kind === 'rounds' ? cfg.mode.rounds : null
    this.st = {
      id, workspacePath: ws, sessionId: sid, status: 'running', round: 0, totalRounds,
      speaking: [], startedAt: deps.now(), elapsedMs: 0, config: cfg,
    }
    if (restored) this.restore(restored)
  }

  /**
   * 从快照接着跑:进行中的一律转成「已暂停」(重启后不自动继续,§7.2 #10)。
   * ★当前轮次只认快照里的 state.round —— transcript 里可能有归到下一轮的插话,不能从它推轮次。
   *  材料不落盘,继续时由 run() 重新取。
   */
  private restore(p: PersistedCouncil): void {
    const live = p.state.status === 'running' || p.state.status === 'finalizing'
    this.st = {
      ...p.state, id: this.id, workspacePath: this.ws, sessionId: this.sid, config: this.cfg,
      status: live ? 'paused' : p.state.status, speaking: [],
    }
    this.transcript = Transcript.fromJSON(p.transcript)
    this.failures = { ...p.failures }
    // ★老快照没有 dropped
    this.dropped = [...(p.dropped ?? [])]
    this.phase = p.phase
    this.spokenThisRound = [...p.spokenThisRound]
    this.resumes = p.resumes
    this.pausedMs = p.pausedMs ?? 0
    // 进行中被恢复(崩溃)的也是从现在起算停着
    this.pausedSince = this.st.status === 'paused' ? (p.pausedSince ?? this.deps.now()) : null
    this.prepared = p.state.round > 0
    for (const m of this.deps.readMessages(this.ws, this.sid)) {
      if (m.who !== 'ai' || m.council?.id !== this.id) continue
      this.replay.set(m.id, m.council.stage === 'failed' ? { ok: false, cancelled: false } : { ok: true, text: m.text })
    }
  }

  get state(): CouncilState {
    return { ...this.st, speaking: [...this.st.speaking], dropped: [...this.dropped] }
  }

  snapshot(): PersistedCouncil {
    return {
      state: this.state, transcript: this.transcript.toJSON(), failures: { ...this.failures }, dropped: [...this.dropped],
      phase: this.phase, spokenThisRound: [...this.spokenThisRound], resumes: this.resumes,
      pausedMs: this.pausedMs, ...(this.pausedSince !== null ? { pausedSince: this.pausedSince } : {}),
    }
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
    const pending = this.st.status === 'running' && this.pauseRequested
    if (this.st.status !== 'paused' && !pending) return
    if (newLeader) {
      this.cfg = { ...this.cfg, leader: newLeader }
      this.st.config = this.cfg
    }
    // 暂停还没生效(当前发言没跑完)就点了继续:撤销暂停即可
    if (pending) {
      this.pauseRequested = false
      this.changed()
      return
    }
    this.resumes++
    this.st.status = 'running'
    delete this.st.waitingForUser
    this.leavePause()
    await this.drive()
  }

  /**
   * app 退出:立即取消正在进行的发言并以「已暂停」落盘(不是 aborted —— 重开后可继续)。
   * ★游标停在当前阶段:被取消的这批(第 1 轮 / 投票)不记账、不进下一阶段,继续时整批重跑,
   *  已经落盘的那几条由 replay 接上。
   */
  suspend(): void {
    if (this.st.status !== 'running' && this.st.status !== 'finalizing') return
    this.suspended = true
    this.pauseRequested = false
    this.st.status = 'paused'
    this.enterPause()
    this.cancelInflight()
    this.st.speaking = []
    this.changed()
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
      delete this.st.waitingForUser
      this.cancelInflight()
      this.changed()
      return
    }
    // ★已经在出最终结果:不能取消领导者,否则 finalize 会把自己打断
    if (this.stopMode === 'finalize' || status === 'finalizing') return
    this.stopMode = 'finalize'
    this.pauseRequested = false
    if (status === 'paused') {
      // ★轮间等用户时下一轮还没开始:最终结果按刚跑完的那一轮出(等待期间的补充归在下一轮,finalize 照样带上)
      if (this.st.waitingForUser) this.st.round--
      this.st.status = 'running'
      delete this.st.waitingForUser
      this.leavePause()
      void this.drive()
      return
    }
    this.cancelInflight()
  }

  /**
   * 插话:立即落盘并进 transcript —— 下一位开始发言时的增量里就有它;正在发言的人这次看不到。
   * 轮间等用户时也收(那就是用户的补充):轮次已经进到下一轮,自然归到下一轮。
   */
  interject(text: string, via?: string): void {
    const accepting = this.st.status === 'running' || (this.st.status === 'paused' && this.st.waitingForUser)
    if (!accepting || this.stopMode || !this.prepared || !text.trim()) return
    const n = this.count(u => u.stage === 'interject') + 1
    // ★领导者正在写本轮总结时插话:总结的输入已经定了,这条归到下一轮 —— 下一轮的席位(插话不受轮次过滤)
    //  和下一轮的总结 / 最终结果(按轮次取发言)才都看得到它。共识模式的草稿 / 投票同理(它们在总结之后)
    const afterSpeeches = this.phase === 'summary' || this.phase === 'consensus-draft' || this.phase === 'consensus-vote'
    const round = afterSpeeches ? this.st.round + 1 : this.st.round
    const msg: ChatMessage = {
      id: `${this.id}:interject:${n}`, who: 'user', text, ...(via ? { via } : {}),
      council: { id: this.id, round, stage: 'interject' },
      ts: new Date(this.deps.now()).toISOString(),
    }
    this.deps.append(this.ws, this.sid, msg)
    this.emit({ type: 'user', message: msg })
    this.transcript.add({ seat: 'user', label: '用户', round, stage: 'interject', text })
    this.changed()
  }

  /**
   * 追问能不能现在开始:null = 可以;否则是错误码。IPC 层据此同步拒绝(followup 本身不等它跑完),
   * 界面才能弹提示,而不是只在主进程日志里留一行。
   */
  followupError(target: 'all' | string): 'not-done' | 'busy' | 'target-invalid' | null {
    if (this.st.status !== 'done') return 'not-done'
    if (this.followingUp) return 'busy'
    const seats = target === 'all' ? this.active() : this.cfg.seats.filter(s => s.id === target)
    return seats.length ? null : 'target-invalid'
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
        const r = await this.speak(s, round, 'followup', followupPrompt(question, delta), { suffix: `:${n}` })
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
    // ★先落盘选择,再重写文件:写文件失败也不能丢掉用户的选定
    this.changed()
    try {
      this.writeResult()
    } catch (e) {
      logError('council', `council ${this.id} could not rewrite the result file`, e instanceof Error ? (e.stack ?? e.message) : String(e))
    }
  }

  // ---- 主循环 ----

  private async drive(): Promise<void> {
    // ★暂停时的 changed() 会同步通知监听方,监听方若立刻 resume / stop('finalize'),此时上一次 run 还没退栈:
    //  记一笔,由正在跑的这次 drive 在 run 返回后接着再跑,而不是直接丢掉
    if (this.driving) {
      this.redrive = true
      return
    }
    this.driving = true
    try {
      do {
        this.redrive = false
        try {
          await this.run()
        } catch (e) {
          logError('council', `council ${this.id} stopped on an unexpected error`, e instanceof Error ? (e.stack ?? e.message) : String(e))
          // ★任何依赖意外抛错(取材料、落盘、写文件…)都不能把状态卡在 running/finalizing:
          //  转为暂停并落盘,用户可以继续;start() 本身只 resolve。已经 aborted 的不能被改回暂停。
          this.st.speaking = []
          if (this.st.status === 'running' || this.st.status === 'finalizing') this.halt()
          else this.changed()
        }
      } while (this.redrive && this.st.status === 'running')
    } finally {
      this.driving = false
    }
  }

  private async run(): Promise<void> {
    // ★在这里而不是 resume() 里清:挂起前那次 run 可能还没退栈,它得一直看到 suspended 才不会接着推进
    this.suspended = false
    this.changed()
    // ★先落议题再取材料:界面上的共商块是从消息里长出来的,取材料失败暂停时也必须看得到它(才有继续 / 结束)
    if (!this.prepared) {
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
    if (!this.materialsLoaded) {
      this.materials = await this.deps.materialsText(this.cfg)
      this.materialsLoaded = true
      if (this.stopMode === 'abort' || this.suspended) return
    }

    for (;;) {
      // 挂起时状态已经是 paused 并落过盘,直接退出
      if (this.stopMode === 'abort' || this.suspended) return
      // 轮间等用户(nextRound 里停下的);同步监听方当场继续的话这里已经是 running,接着跑
      if (this.st.status === 'paused') return
      if (this.stopMode === 'finalize') this.phase = 'final'
      else if (this.pauseRequested) {
        this.pauseRequested = false
        return this.halt()
      }
      switch (this.phase) {
        case 'answer':
          await this.answerRound()
          if (!this.suspended) this.endRound()
          break
        case 'critique': {
          const next = this.active().find(s => !this.spokenThisRound.includes(s.id))
          if (next) await this.critique(next, this.st.round)
          else this.endRound()
          break
        }
        case 'summary': {
          const r = await this.leaderSummary(this.st.round)
          if (r.ok) {
            if (this.cfg.mode.kind === 'consensus') this.phase = 'consensus-draft'
            else this.nextRound()
          } else if (!r.cancelled) return this.halt()
          break
        }
        case 'consensus-draft': {
          const r = await this.consensusDraft(this.st.round)
          if (r.ok) this.phase = 'consensus-vote'
          else if (!r.cancelled) return this.halt()
          break
        }
        case 'consensus-vote':
          await this.consensusVote(this.st.round)
          break
        case 'final':
          return this.finalize(this.st.round)
      }
    }
  }

  /**
   * 本轮结束:最后一轮不再总结,由最终结果代替(只有 1 轮 = 各自作答后直接出结果,§5.1);§7.3:讨论方只剩 1 个也直接出结果。
   * ★共识模式每轮都要总结(草稿和下一轮都要用),轮数 / 时间上限放到投票之后判断。
   */
  private endRound(): void {
    if (this.active().length <= 1) this.phase = 'final'
    else if (this.cfg.mode.kind === 'consensus') this.phase = 'summary'
    else this.phase = this.st.round >= this.cfg.mode.rounds ? 'final' : 'summary'
  }

  private nextRound(): void {
    this.st.round++
    this.spokenThisRound = []
    this.phase = 'critique'
    // ★「每轮结束后等我」:游标先进到下一轮再停 —— 等待期间的补充按当前轮次落进下一轮,下一轮的席位和总结都看得到。
    //  最后一轮之后没有总结、直接出结果,也就走不到这里。用户先点的暂停由这次停顿兑现。
    //  已经点了「结束」(总结恰好在取消前跑完)就不停,直接去出结果
    if (this.cfg.pauseBetweenRounds !== false && !this.stopMode) {
      this.pauseRequested = false
      this.st.status = 'paused'
      this.st.waitingForUser = true
      this.enterPause()
    }
    this.changed()
  }

  // ---- 轮次 ----

  /** 第 1 轮:全部席位并行、各自独立作答(提示词里没有任何别人的内容)。 */
  private async answerRound(): Promise<void> {
    const seats = this.active()
    const results = await Promise.all(seats.map(s =>
      this.speak(s, 1, 'answer', answerPrompt(this.cfg, this.materials, s), { attachments: this.cfg.attachments })))
    if (this.suspended) return this.keepForReplay(seats, 1, 'answer', results)
    // ★结束后再按配置顺序写进 transcript,而不是按完成先后 —— 顺序稳定,后续轮次喂给大家的增量一致
    seats.forEach((s, i) => this.record(s, 1, 'answer', results[i]))
  }

  /** 第 2 轮起:按配置顺序依次发言(一次一位),每人看到上一轮总结 + 本轮在他之前的发言 + 插话。 */
  private async critique(s: CouncilSeat, round: number): Promise<void> {
    // ★critiquePrompt 只留本轮及以后的发言;共识模式上一轮的不同意理由必须进本轮上下文(§5.2),把它们当本轮的带进去
    const delta = this.transcript.unseenFor(s.id).map(u =>
      (u.stage === 'consensus-vote' && u.round === round - 1 && parseVote(u.text) !== 'agree' ? { ...u, round } : u))
    const resumed = this.deps.seatResumed(s.id)
    // ★不同意的理由只有对着被否的那份草稿才看得懂(「第二点漏了回滚」—— 哪个第二点?),草稿单独成节、标明是领导者的
    const rejectedDraft = this.latestDraft(round - 1)
    const prompt = critiquePrompt(this.cfg, s, round, this.transcript.latestSummary(), delta, resumed, this.materials, rejectedDraft)
    // ★续上原生会话的席位提示词里不再带议题,附件也不重复给
    const r = await this.speak(s, round, 'critique', prompt, { attachments: resumed ? [] : this.cfg.attachments })
    // ★先标记再记账:record 里的落盘必须已经带上他,否则崩溃后重启会让他把这一轮再说一遍
    if (r.ok || !r.cancelled) this.spokenThisRound.push(s.id)
    this.record(s, round, 'critique', r)
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

  // ---- 共识(§5.2) ----

  /** 领导者把本轮多数已认可的内容中立地合并成「目前各方的共同点」草稿;失败重试一次。 */
  private async consensusDraft(round: number): Promise<Spoken> {
    const items = this.transcript.round(round).filter(u => u.stage !== 'summary')
    const r = await this.leader(round, 'consensus-draft', consensusDraftPrompt(this.cfg, round, items, this.objections(round - 1)))
    if (!r.ok) return r
    this.transcript.add({ seat: this.cfg.leader.id, label: this.cfg.leader.label, round, stage: 'consensus-draft', text: r.text })
    this.changed()
    return r
  }

  /**
   * 全部在场席位并行对草稿投票。全员「同意」→ 出最终结果;否则到上限也出结果,没到就进下一轮。
   * ★「无法识别」和投票失败都算不同意;投票失败和其他发言一样计入连续失败。
   */
  private async consensusVote(round: number): Promise<void> {
    const draft = this.latestDraft(round)
    const seats = this.active()
    const results = await Promise.all(seats.map(s => this.speak(s, round, 'consensus-vote', consensusVotePrompt(s, draft?.text ?? ''))))
    if (this.suspended) return this.keepForReplay(seats, round, 'consensus-vote', results)
    seats.forEach((s, i) => this.record(s, round, 'consensus-vote', results[i]))
    // 被「结束」取消的投票:主循环顶部会转去出结果,这里不判定
    if (this.stopMode) return
    const agreed = results.every(r => r.ok && parseVote(r.text) === 'agree')
    const mode = this.cfg.mode
    const capped = mode.kind === 'consensus'
      && (round >= mode.maxRounds || this.activeMs() >= mode.maxMinutes * 60_000)
    if (agreed || capped || this.active().length <= 1) this.phase = 'final'
    else this.nextRound()
  }

  /** 该轮最后一份共同点草稿(重试 / 继续可能写过多份)。 */
  private latestDraft(round: number): Utterance | undefined {
    return this.transcript.toJSON().items.filter(u => u.round === round && u.stage === 'consensus-draft').at(-1)
  }

  /** 该轮没投「同意」的票(含无法识别的),原样带发言者。 */
  private objections(round: number): Utterance[] {
    return this.transcript.toJSON().items.filter(u => u.round === round && u.stage === 'consensus-vote' && parseVote(u.text) !== 'agree')
  }

  /** 最近一轮投票里没有同意的理由,形如 `${label}: ${reason}`;交给最终结果写进 disagreements。 */
  private unresolved(): string[] {
    const votes = this.transcript.toJSON().items.filter(u => u.stage === 'consensus-vote')
    const last = votes.at(-1)?.round
    return votes
      .filter(u => u.round === last && parseVote(u.text) !== 'agree')
      .map(u => `${u.label}: ${voteReason(u.text)}`)
  }

  private async finalize(lastRound: number): Promise<void> {
    this.st.status = 'finalizing'
    this.changed()
    const summaries = this.summaries()
    // 总结途中被「结束」时,归到下一轮的插话也要给最终结果看到
    const lastItems = this.transcript.toJSON().items.filter(u =>
      (u.round === lastRound && u.stage !== 'summary') || (u.round > lastRound && u.stage === 'interject'))
    const leader = this.cfg.leader
    const r = await this.leader(lastRound, 'final', finalPrompt(this.cfg, summaries, lastItems, this.unresolved()), (text) => {
      const { result, body } = parseCouncilResult(text)
      return { text: body, councilResult: result ?? undefined }
    })
    if (this.stopMode === 'abort') return
    if (!r.ok) return this.halt()
    this.transcript.add({ seat: leader.id, label: leader.label, round: lastRound, stage: 'final', text: r.text })
    const path = join(this.ws, '.forge', 'council', councilFileName(this.st.startedAt, this.cfg.topic, this.id))
    this.writeResult(path)
    this.st.resultFile = path
    this.st.status = 'done'
    this.changed()
  }

  private halt(): void {
    // 领导者失败等原因先停下时,用户之前点的暂停已经兑现,不能留到继续之后再停一次
    this.pauseRequested = false
    this.st.status = 'paused'
    this.enterPause()
    this.changed()
  }

  private enterPause(): void {
    if (this.pausedSince === null) this.pausedSince = this.deps.now()
  }

  private leavePause(): void {
    if (this.pausedSince === null) return
    this.pausedMs += this.deps.now() - this.pausedSince
    this.pausedSince = null
  }

  /** 讨论真正在跑的时长:墙钟减去停着的时间。 */
  private activeMs(): number {
    const pausedNow = this.pausedSince !== null ? this.deps.now() - this.pausedSince : 0
    return this.deps.now() - this.st.startedAt - this.pausedMs - pausedNow
  }

  // ---- 发言 ----

  /** 领导者发言,失败重试一次(§7.3)。 */
  private async leader(
    round: number, stage: 'summary' | 'consensus-draft' | 'final', prompt: string, shape?: Shape,
  ): Promise<Spoken> {
    const tag = this.resumes ? `:r${this.resumes}` : ''
    // 领导者的提示词每次都重带议题,附件也每次都给
    const attachments = this.cfg.attachments
    const first = await this.speak(this.cfg.leader, round, stage, prompt, { suffix: tag, shape, attachments })
    // 被「结束」取消的不重试
    if (first.ok || first.cancelled) return first
    // ★重试用不同的消息 id:第一次失败已经以 failed 消息落盘,不能和重试那条撞 id
    return this.speak(this.cfg.leader, round, stage, prompt, { suffix: `${tag}:retry`, shape, attachments })
  }

  /**
   * 跑一次发言:流式转发到 chat:event,结束后落盘一条消息(失败 = stage 'failed' 的空消息)。
   * 被「结束」取消的发言不落盘、不算失败,返回 cancelled。
   * ★消息 id 由引擎按 (轮次, 席位, 阶段) 生成,不用 runSeat 的 msgId:同一次发言的 start/delta/done 共用,
   *  且可预测、可去重。
   */
  private async speak(seat: CouncilSeat, round: number, stage: CouncilStage, prompt: string, opts: SpeakOpts = {}): Promise<Spoken> {
    const { suffix = '', shape, attachments = [] } = opts
    const id = this.msgId(seat, round, stage, suffix)
    const prior = this.replay.get(id)
    if (prior) {
      this.replay.delete(id)
      return prior
    }
    let think = ''
    let thinkSince: number | null = null
    let started = false
    const council = { id: this.id, seat: seat.id, round, stage }
    // ★runSeat 在超时/失败 settle 之后仍可能漏出回调;结果一到就关门,之后的一律丢弃
    let live = true
    this.st.speaking = [...this.st.speaking, seat.id]
    this.changed()
    const run = this.deps.runSeat(this.id, seat, prompt, { ...this.deps.seatDeps, workspacePath: this.ws, sessionId: this.sid, cwd: this.cwd() }, {
      // ★每个流式事件都带 council:渲染端重拉历史会丢掉在途的共商发言,之后的增量要能把它重建回共商块里
      onStart: () => { if (!live) return; started = true; this.emit({ type: 'assistant-start', id, model: seat.label, council }) },
      onDelta: (_m, t) => { if (!live) return; this.emit({ type: 'assistant-delta', id, text: t, council }) },
      onThink: (_m, t) => { if (!live) return; think += t; thinkSince ??= this.deps.now(); this.emit({ type: 'think-delta', id, text: t, council }) },
      onReplace: (_m, t) => { if (!live) return; this.emit({ type: 'assistant-replace', id, text: t, council }) },
    }, attachments)
    const handle: Inflight = { cancelled: false, cancel: () => { handle.cancelled = true; run.cancel() } }
    this.inflight.add(handle)
    const r = await run.done
    this.inflight.delete(handle)
    live = false
    this.st.speaking = this.st.speaking.filter(x => x !== seat.id)
    if (!r.ok && handle.cancelled) {
      // ★已经广播过 assistant-start 的流必须有终结事件,否则全局的流式状态(宠物忙碌、streamingIds)永远不清;
      //  只广播不落盘 —— 被取消不算失败,不留 failed 消息
      if (started) this.emit({ type: 'error', id, error: 'cancelled' })
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
      ? { ...base, ...(shape ? shape(r.text) : { text: r.text }), ...(steps.length ? { think: { label: '已思考', steps, ...(thinkSince !== null ? { elapsed: thinkElapsed(thinkSince, this.deps.now()) } : {}) } } : {}) }
      : base
    this.deps.append(this.ws, this.sid, msg)
    this.emit({ type: 'done', message: msg })
    this.changed()
    return r.ok ? { ok: true, text: r.text } : { ok: false, cancelled: false }
  }

  /** 挂起时作废的一批并行发言里,已经落盘的(成功或失败)留给继续后的重跑直接取用。 */
  private keepForReplay(seats: CouncilSeat[], round: number, stage: CouncilStage, results: Spoken[]): void {
    seats.forEach((s, i) => {
      const r = results[i]
      if (r.ok || !r.cancelled) this.replay.set(this.msgId(s, round, stage), r)
    })
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

  private msgId(seat: CouncilSeat, round: number, stage: CouncilStage, suffix = ''): string {
    return `${this.id}:${round}:${seat.id}:${stage}${suffix}`
  }

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
    const snap = this.snapshot()
    this.deps.emitState(snap.state)
    this.deps.persist(snap)
  }
}

/** 去掉投票开头的「不同意」(含 Markdown 符号和标点),剩下的就是理由;无法识别的投票整句当理由。 */
function voteReason(text: string): string {
  const t = text.trim()
  const reason = t.replace(/^[\s*_#>`~\-"'“「【\[(（]*不同意[*_」】\]）)]*[\s,，:：.。;；!！]*/, '').trim()
  return reason || t
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
