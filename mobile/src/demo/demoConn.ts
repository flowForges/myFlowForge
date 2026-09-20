import { CH } from '../../../src/main/ipc/channels'
import type { ChatMessage, ChatSession, SessionsFile, WorkspaceMeta } from '../../../src/shared/types'
import { DEMO_FALLBACK, replyFor, type DemoTool } from './script'

/**
 * 体验模式的**假连接**。
 *
 * ★★★核心决定:它实现的是 `useConn()` 那套 `invoke` / `on` 接口本身,**不是**在每个界面里
 *  写 `if (demo) …`。理由有两条,第二条才是真正的:
 *   ① 界面一行都不用改,自然也不会漏;
 *   ② 用户的要求是「**执行状态跟真实的一样**」。真实感不是靠模仿外观,是靠走**同一条代码路径** ——
 *      流式是真的逐字来的、工具卡是真的先 run 后 ok、忙碌态是真的由 done 事件解除的。
 *      在界面层伪造这些,迟早会和真链路长得不一样,而那种偏差没人会当 bug 报,只会觉得这 app 很假。
 *
 * ★★**完全离线**:这个文件不发一个字节出去,也没有任何 import 会发。飞行模式下必须照常走完 ——
 *  这正是它存在的理由(见 `script.ts` 顶部:审核员在哪、走什么网络,我们既不知道也控制不了)。
 *
 * ★**不落盘**。退出体验模式,这里造的东西全部消失。体验数据混进真实的会话存储是最糟的结果。
 */

/** 体验工作区的「路径」。★故意不像真路径 —— 万一哪天它漏进了真实存储,一眼就认得出来。 */
export const DEMO_WS_PATH = 'demo://体验工作区'
export const DEMO_WS_NAME = '体验工作区'
/** 用户要求:体验工作区里最多 5 条会话。 */
export const DEMO_MAX_SESSIONS = 5
/** 新建工作区要连真机 —— 它得在真的磁盘上开目录、开 git worktree。 */
export const DEMO_NEEDS_HOST = '体验模式里新建不了工作区 —— 它要在你电脑的真实磁盘上开目录和 git worktree。先连上你自己的电脑。'

type EventCb = (payload: unknown) => void
type Listeners = Map<string, Set<EventCb>>

const now = () => Date.now()
const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 9)}`
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function session(title: string): ChatSession {
  return { id: uid('s'), title, mode: 'chat', createdAt: now(), lastMessageAt: now() }
}

/**
 * 开一个体验连接。返回的东西形状上和 `useConn()` 的一个子集一致。
 *
 * @param onLog 可选,测试用:把内部发生的事记下来。
 */
export function createDemoConn() {
  const listeners: Listeners = new Map()
  /** 每条会话的消息。★只在内存里。 */
  const history = new Map<string, ChatMessage[]>()
  const first = session('试试问我点什么')
  let sessions: ChatSession[] = [first]
  let activeSessionId = first.id
  history.set(first.id, [])
  /** 正在跑的那一轮 —— 「停止」要能真的打断它。 */
  let running: { sessionId: string; cancelled: boolean } | null = null

  const emit = (ch: string, payload: unknown) => {
    for (const cb of listeners.get(ch) ?? []) {
      try { cb(payload) } catch { /* 一个监听器炸了不该带走其它的 */ }
    }
  }

  const on = (ch: string, cb: EventCb) => {
    let set = listeners.get(ch)
    if (!set) { set = new Set(); listeners.set(ch, set) }
    set.add(cb)
    return () => { set!.delete(cb) }
  }

  /** 走一轮对话:user → assistant-start → 工具卡 → 逐字 → done。和真链路同样的事件序列。 */
  async function runTurn(sessionId: string, text: string) {
    const msgs = history.get(sessionId) ?? []
    const userMsg: ChatMessage = { id: uid('u'), who: 'user', text, ts: new Date().toISOString(), via: 'iPhone' }
    msgs.push(userMsg)
    history.set(sessionId, msgs)
    emit(CH.chatEvent, { workspacePath: DEMO_WS_PATH, sessionId, type: 'user', message: userMsg })

    // 第一条消息之后把会话标题改成问题本身 —— 真链路也是这么干的,列表上才认得出哪条是哪条。
    const s = sessions.find((x) => x.id === sessionId)
    if (s && msgs.length === 1) {
      s.title = text.length > 18 ? text.slice(0, 18) + '…' : text
      emit(CH.sessionsChanged, { workspacePath: DEMO_WS_PATH })
    }
    if (s) s.lastMessageAt = now()

    const turn = { sessionId, cancelled: false }
    running = turn
    const id = uid('a')
    // ★先给一小段「在想」的时间。立刻开始吐字看起来像查表,而它本来就是查表 ——
    //  这点延迟不是装饰,是让节奏读起来像真的在跑。
    await sleep(420)
    if (turn.cancelled) return
    emit(CH.chatEvent, { workspacePath: DEMO_WS_PATH, sessionId, type: 'assistant-start', id, model: 'claude-opus-5' })

    const reply = replyFor(text)

    for (const t of reply.tools ?? []) {
      if (turn.cancelled) break
      const toolId = uid('t')
      emit(CH.chatEvent, {
        workspacePath: DEMO_WS_PATH, sessionId, type: 'tool-activity', id,
        tool: { id: toolId, title: `${t.name}${t.detail ? ' ' + t.detail : ''}`, name: t.name, status: 'run' },
      })
      await sleep(t.ms ?? 700)
      if (turn.cancelled) break
      // ★同一个 `tool.id` 再发一次 —— 界面按 id 原地替换(见 useChat 的 tool-activity 分支)。
      //  换个 id 的话,一次调用会在卡片列表里出现两张。
      emit(CH.chatEvent, {
        workspacePath: DEMO_WS_PATH, sessionId, type: 'tool-activity', id,
        tool: { id: toolId, title: `${t.name}${t.detail ? ' ' + t.detail : ''}`, name: t.name, status: 'ok', output: t.output },
      })
      await sleep(180)
    }

    // 逐字流式。★按「块」发而不是一个字符一个字符:真 provider 的 delta 本来就是成块的,
    //  而且一次一个字符在低端机上会把 JS 线程钉死。
    let acc = ''
    const body = reply.text
    for (let i = 0; i < body.length && !turn.cancelled; i += 3) {
      const chunk = body.slice(i, i + 3)
      acc += chunk
      emit(CH.chatEvent, { workspacePath: DEMO_WS_PATH, sessionId, type: 'assistant-delta', id, text: chunk })
      await sleep(16)
    }

    const aiMsg: ChatMessage = {
      id, who: 'ai', text: turn.cancelled ? acc : body, ts: new Date().toISOString(), model: 'claude-opus-5', provider: 'claude',
    }
    msgs.push(aiMsg)
    history.set(sessionId, msgs)
    emit(CH.chatEvent, { workspacePath: DEMO_WS_PATH, sessionId, type: 'done', id, message: aiMsg })
    if (running === turn) running = null
  }

  const workspaces = (): WorkspaceMeta[] => [{
    name: DEMO_WS_NAME, path: DEMO_WS_PATH, projectCount: 1, workflowId: '', status: 'idle',
    pinned: false, archived: false, archivedAt: null, createdAt: now(), description: '体验模式 · 不连接任何电脑',
  }]

  const sessionsFile = (): SessionsFile => ({ sessions: sessions.slice(), activeSessionId })

  async function invoke(ch: string, args: unknown[] = []): Promise<unknown> {
    const a0 = args[0] as Record<string, unknown> | string | undefined
    const arg = (k: string): string | undefined =>
      typeof a0 === 'object' && a0 ? (a0[k] as string | undefined) : undefined

    switch (ch) {
      case CH.workspacesList: return workspaces()
      case CH.workspaceGet:
        return { name: DEMO_WS_NAME, path: DEMO_WS_PATH, workflowId: '', stages: [], workflows: [], projects: [], status: 'idle', plugins: [], stepPlugins: [] }
      case CH.sessionList: return sessionsFile()
      case CH.chatHistory: {
        const sid = arg('sessionId') ?? activeSessionId
        return { messages: history.get(sid) ?? [] }
      }
      case CH.chatSend: {
        const sid = arg('sessionId') ?? activeSessionId
        const text = String(arg('text') ?? '')
        // 不 await —— 真链路也是「发出去就返回,后面靠事件推」。await 的话界面会卡到整轮结束。
        void runTurn(sid, text)
        return { ok: true }
      }
      case CH.chatStop:
        if (running) running.cancelled = true
        return { ok: true }
      case CH.sessionNew: {
        if (sessions.length >= DEMO_MAX_SESSIONS) {
          throw new Error(`体验模式最多 ${DEMO_MAX_SESSIONS} 条会话。连上你自己的电脑之后就没有这个限制了。`)
        }
        const s = session('新会话')
        sessions.push(s)
        history.set(s.id, [])
        activeSessionId = s.id
        emit(CH.sessionsChanged, { workspacePath: DEMO_WS_PATH })
        return sessionsFile()
      }
      case CH.sessionClose: {
        const sid = arg('sessionId') ?? String(args[1] ?? '')
        // ★最后一条不给关。关光了这一屏就空了,而体验模式里人没有「再建一个工作区」这条退路。
        if (sessions.length > 1) {
          sessions = sessions.filter((x) => x.id !== sid)
          history.delete(sid)
          if (activeSessionId === sid) activeSessionId = sessions[0].id
          emit(CH.sessionsChanged, { workspacePath: DEMO_WS_PATH })
        }
        return sessionsFile()
      }
      case CH.sessionRename: {
        const sid = arg('sessionId')
        const title = arg('title')
        const s = sessions.find((x) => x.id === sid)
        if (s && title) s.title = title
        emit(CH.sessionsChanged, { workspacePath: DEMO_WS_PATH })
        return sessionsFile()
      }
      // ★★新建工作区必须**明确拒绝并说清为什么**,不能静默失败也不能假装成功 ——
      //  假装成功之后人会去里面找自己的代码,那才是最坏的结果。
      case CH.workspaceCreate:
      case CH.workspaceSetup:
        throw new Error(DEMO_NEEDS_HOST)

      // 下面这些界面会问,但体验模式里一律是空的。**返回形状正确的空值**,不是抛错 ——
      // 抛错会让界面进红色的失败态,而「没有」和「坏了」是两回事。
      case CH.chatGateState: return { gates: [] }
      case CH.chatQueueState: return { queued: 0 }
      case CH.agentsDetect: return [{ id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'claude-opus-5', label: 'Opus' }] }]
      case CH.commandsList: return { commands: [], supported: false }
      case CH.configListWorkflows: return []
      case CH.configListProjects: return []
      case CH.changesMulti: return { repos: [] }
      case CH.fsTree: return { entries: [] }
      case CH.mcpOverview: return { servers: [] }
      case CH.customStagesList: return []
      case CH.configGetHostSettings: return {}
      default:
        // ★不认识的频道**明确报出来**,别静默回 undefined。静默回的话,某个界面会拿着 undefined
        //  往下走,然后在十几行之后炸掉,而错误信息里不会有「体验模式」四个字。
        throw new Error(`体验模式不支持这个操作(${ch})。连上你自己的电脑之后就有了。`)
    }
  }

  return {
    invoke,
    on,
    /** 测试用:当前有几条会话。 */
    get sessionCount() { return sessions.length },
    get activeSessionId() { return activeSessionId },
  }
}

/**
 * 体验模式对外宣称支持的方法表。
 *
 * ★★界面上一大片功能是按「对面报没报这个方法」置灰的(决策 B-2)。给空集合的话,
 *  体验模式一打开就是一屏灰按钮 —— 那比没有体验模式更糟。
 * ★这里列的是 `invoke` 里**真的处理了**的那些。列一个没实现的,点下去会撞到 default 分支抛错,
 *  而用户看到的是「点了报错」—— 比置灰更难理解。两者必须一致。
 */
export const DEMO_METHODS: ReadonlySet<string> = new Set([
  CH.workspacesList, CH.workspaceGet, CH.sessionList, CH.sessionNew, CH.sessionClose, CH.sessionRename,
  CH.chatHistory, CH.chatSend, CH.chatStop, CH.chatGateState, CH.chatQueueState,
  CH.agentsDetect, CH.commandsList, CH.configListWorkflows, CH.configListProjects,
  CH.changesMulti, CH.fsTree, CH.mcpOverview, CH.customStagesList, CH.configGetHostSettings,
])

export type DemoConn = ReturnType<typeof createDemoConn>
export { DEMO_FALLBACK }
export type { DemoTool }
