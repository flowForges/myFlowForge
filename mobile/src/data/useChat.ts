import { useCallback, useEffect, useRef, useState } from 'react'
import { CH } from '../../../src/main/ipc/channels'
import type { Attachment, ChatMessage, DelegateBatch, SubagentCard, ToolActivity } from '../../../src/shared/types'
import { useConn } from '../net/conn'

/**
 * 一个会话的消息流:先拉历史,再跟着 `chat:event` 往下长。
 *
 * 手机端**有意只认一小撮事件**(user / assistant-start / delta / replace / think / tool-activity /
 * subagent / delegate-* / done / error)。run2 那一大套先不画 —— 不是忘了,是分批做。
 * 没认的事件一律忽略,绝不当成错误。
 */

export type Msg = {
  id: string
  who: 'user' | 'ai'
  text: string
  think: string
  model?: string
  /** 产出这条回复的代理 id(claude / codex / …)。用来推「换代理」提示,和 `model` 不是一回事:
   *  `model` 是显示名(「Claude Code · Opus」),换个模型不算换代理。 */
  provider?: string
  ts?: string
  /** 这一轮代理自己跑过的工具(读文件 / 改文件 / 跑命令)。桌面端的「执行」块拿的是同一份数据。 */
  tools?: ToolActivity[]
  /** 这一轮主代理用 Task 起的内置子代理。落档在消息上,刷新还在。 */
  subagents?: SubagentCard[]
  /**
   * `forge_delegate` 发出去的后台委派批次。**只在实时流里有** —— 服务端根本不落档
   * (主轮次结束后它们还在跑,汇总结果之后会作为另一条消息回来)。
   * 所以刷新一下这些卡就没了,这是设计如此,不是丢数据。
   */
  delegates?: DelegateBatch[]
  /** 这一轮开始的 epoch 毫秒。轮次分隔线优先用它 —— `ts` 只有 `HH:MM:SS`,不知道是哪一天。 */
  startedAt?: number
  /** 还在流式吐字。用来画光标,也用来决定停止键亮不亮。 */
  streaming?: boolean
  error?: string
}

const fromHistory = (m: ChatMessage): Msg => ({
  id: m.id,
  who: m.who,
  text: m.text ?? '',
  // 历史里的 think 是结构化的(label + steps),流式来的 think-delta 是散字。
  // 手机端只画一段文本,所以落档那份在这里压平。
  think: m.think ? [m.think.label, ...(m.think.steps ?? [])].filter(Boolean).join('\n') : '',
  model: m.model,
  provider: m.provider,
  ts: m.ts,
  tools: m.tools,
  subagents: m.subagents,
  startedAt: m.startedAt,
})

type Evt = {
  workspacePath?: string
  sessionId?: string
  type?: string
  id?: string
  text?: string
  model?: string
  message?: ChatMessage
  error?: string
  tool?: ToolActivity
  sub?: SubagentCard
  batch?: DelegateBatch
  agentId?: string
  status?: 'run' | 'ok' | 'idle'
  output?: string
  activity?: string
}

export function useChat(wsPath: string | null, sessionId: string | null) {
  const { invoke, on, online } = useConn()
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)


  // 订阅要盯着「当前是哪个会话」,而回调本身不该因为换会话而重建订阅之外的东西。
  const keyRef = useRef({ wsPath, sessionId })
  keyRef.current = { wsPath, sessionId }

  const upsert = useCallback((id: string, fn: (m: Msg) => Msg, seed?: Msg) => {
    setMsgs((prev) => {
      const i = prev.findIndex((m) => m.id === id)
      if (i < 0) return seed ? [...prev, fn(seed)] : prev
      const n = prev.slice()
      n[i] = fn(n[i])
      return n
    })
  }, [])

  // ★同样是「先订阅再拉历史」。反过来的话,历史那个 promise 完全可能在几条 delta 之后才 resolve,
  //  一 setMsgs 就把刚流进来的字全盖没了 —— 界面上是「代理说了一半突然回退」。
  useEffect(() => {
    const off = on(CH.chatEvent, (payload) => {
      const e = payload as Evt
      const k = keyRef.current
      if (!e || e.workspacePath !== k.wsPath || e.sessionId !== k.sessionId) return
      switch (e.type) {
        case 'user':
          if (e.message) setMsgs((p) => [...p, fromHistory(e.message!)])
          break
        case 'assistant-start':
          if (e.id)
            setMsgs((p) =>
              p.some((m) => m.id === e.id)
                ? p
                : [...p, { id: e.id!, who: 'ai', text: '', think: '', model: e.model, streaming: true, startedAt: Date.now() }],
            )
          setBusy(true)
          break
        // 工具卡。`e.id` 是**这条回复**的 id,`e.tool.id` 才是具体那次调用 —— 按后者原地替换,
        // 因为同一次调用会来两趟:phase 'start' 只有标题(status 'run'),phase 'done' 才带输出和结果。
        // 追加而不是替换的话,一次调用会在卡片列表里出现两张。
        case 'tool-activity': {
          const t = e.tool
          if (!e.id || !t?.id) break
          upsert(
            e.id,
            (m) => {
              const tools = m.tools ?? []
              const i = tools.findIndex((x) => x.id === t.id)
              if (i < 0) return { ...m, tools: [...tools, t] }
              const n = tools.slice()
              n[i] = t
              return { ...m, tools: n }
            },
            { id: e.id, who: 'ai', text: '', think: '', streaming: true, startedAt: Date.now() },
          )
          break
        }
        // 内置子代理(Task)。和工具卡一样按自己的 id 原地替换:start 只有类型和描述,
        // 之后的 update 补它自己的工具步,done 才带结果。
        case 'subagent': {
          const sub = e.sub
          if (!e.id || !sub?.id) break
          upsert(
            e.id,
            (m) => {
              const list = m.subagents ?? []
              const i = list.findIndex((x) => x.id === sub.id)
              if (i < 0) return { ...m, subagents: [...list, sub] }
              const n = list.slice()
              n[i] = sub
              return { ...m, subagents: n }
            },
            { id: e.id, who: 'ai', text: '', think: '', streaming: true, startedAt: Date.now() },
          )
          break
        }
        case 'delegate-start': {
          const batch = e.batch
          if (!e.id || !batch?.runId) break
          upsert(
            e.id,
            (m) => {
              const list = m.delegates ?? []
              return list.some((b) => b.runId === batch.runId) ? m : { ...m, delegates: [...list, batch] }
            },
            { id: e.id, who: 'ai', text: '', think: '', streaming: true, startedAt: Date.now() },
          )
          break
        }
        case 'delegate-progress': {
          // 一条 progress 只翻**一个**子代理的状态。整批替换会把别的子代理刚更新的进度盖回去。
          if (!e.id || !e.agentId) break
          upsert(e.id, (m) => ({
            ...m,
            delegates: (m.delegates ?? []).map((b) => ({
              ...b,
              agents: b.agents.map((a) =>
                a.agentId !== e.agentId
                  ? a
                  : {
                      ...a,
                      status: e.status ?? a.status,
                      // ★`undefined` 不能覆盖已有的值:progress 常常只带 activity 不带 output,
                      //  照单全收会把上一条刚送到的输出抹掉。
                      output: e.output ?? a.output,
                      activity: e.activity ?? a.activity,
                    },
              ),
            })),
          }))
          break
        }
        case 'delegate-done':
          if (e.id) upsert(e.id, (m) => ({ ...m, delegates: (m.delegates ?? []).map((b) => ({ ...b, done: true })) }))
          break
        case 'assistant-delta':
          if (e.id)
            upsert(e.id, (m) => ({ ...m, text: m.text + (e.text ?? ''), streaming: true }), {
              id: e.id,
              who: 'ai',
              text: '',
              think: '',
              streaming: true,
            })
          break
        case 'assistant-replace':
          if (e.id) upsert(e.id, (m) => ({ ...m, text: e.text ?? '', streaming: true }))
          break
        case 'think-delta':
          if (e.id)
            upsert(e.id, (m) => ({ ...m, think: m.think + (e.text ?? '') }), {
              id: e.id,
              who: 'ai',
              text: '',
              think: '',
              streaming: true,
            })
          break
        case 'done':
          // done 带的是这一轮**实际落档**的那条消息。以它为准替换掉流式攒的那份。
          if (e.message) {
            const done = fromHistory(e.message)
            setMsgs((p) => {
              const i = p.findIndex((m) => m.id === done.id)
              if (i < 0) return [...p, done]
              const n = p.slice()
              // ★落档那份没带 tools 时,别把流式期间攒的那些卡片抹掉。已经看了十几秒的执行过程
              //  在最后一刻整段消失,比一开始就没有更像出了问题。
              // ★委派批次**服务端不落档**,所以 done 那份里永远没有 —— 必须从流式那份接过来,
              //  否则主轮次一结束,还在跑的那几个子代理就整块消失了。
              n[i] = {
                ...done,
                tools: done.tools ?? n[i].tools,
                subagents: done.subagents ?? n[i].subagents,
                delegates: n[i].delegates,
                startedAt: done.startedAt ?? n[i].startedAt,
              }
              return n
            })
          }
          setBusy(false)
          break
        case 'error':
          // ★错误路径下 message 常常**是有正文的**(provider 先流出了答案再以非零退出收尾)。
          //  只认 error 就会把「答完了但收尾有告警」显示成彻底失败。
          if (e.id)
            upsert(e.id, (m) => ({
              ...m,
              text: e.message?.text || m.text,
              error: e.error ?? '出错',
              streaming: false,
            }))
          setBusy(false)
          break
        default:
          break
      }
    })
    return off
  }, [on, upsert])

  // 换会话就清空。**断线不清空** —— 已经拉下来的内容照样能读,这不是「拿缓存假装在线」:
  // 顶部有明确的断线横幅,发送 / 答门 / 停止全部禁用。清掉反而更糟:人打开手机就为了看
  // 代理刚才说了什么,结果一断网屏幕就白了。
  useEffect(() => {
    setMsgs([])
  }, [wsPath, sessionId])

  useEffect(() => {
    if (!wsPath || !sessionId || !online) return
    let alive = true
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const hist = (await invoke(CH.chatHistory, [{ workspacePath: wsPath, sessionId }])) as ChatMessage[]
        if (!alive) return
        const seen = new Set(hist.map((m) => m.id))
        // 历史落地时把「加载期间流进来的新消息」接在后面,而不是整份替换。
        setMsgs((live) => [...hist.map(fromHistory), ...live.filter((m) => !seen.has(m.id))])
        setLoading(false)
      } catch (e) {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      }
      try {
        // ★停止键的初值必须问服务端要。手机是**半路加入**的:连上的时候那一轮多半已经在跑了,
        //  而 busy 只有收到 assistant-start 才会变真 —— 那条事件早在我们连上之前就播完了。
        //  不问的话,停止键一直是灰的:代理在跑飞,而你按不动。
        const q = (await invoke(CH.chatQueueState, [{ workspacePath: wsPath }])) as {
          runningSessionIds?: string[]
          runningSessionId?: string | null
        }
        if (!alive) return
        const running = q?.runningSessionIds ?? (q?.runningSessionId ? [q.runningSessionId] : [])
        setBusy(running.includes(sessionId))
      } catch {
        // 拿不到就算了 —— 停止键灰着比整屏报错好。
      }
    })()
    return () => {
      alive = false
    }
  }, [wsPath, sessionId, online, invoke])

  // 队列事件是全工作区广播的,顺带把 busy 校准回来(比如别的设备停了这一轮)。
  useEffect(() => {
    const off = on(CH.chatQueueEvent, (payload) => {
      const q = payload as { workspacePath?: string; runningSessionIds?: string[] }
      const k = keyRef.current
      if (!q || q.workspacePath !== k.wsPath || !k.sessionId) return
      setBusy((q.runningSessionIds ?? []).includes(k.sessionId))
    })
    return off
  }, [on])

  const send = useCallback(
    async (p: {
      text: string
      agent: string
      agentLabel: string
      model: string
      permissionMode?: string
      /** 转成附件的那几坨内容(见 `@shared/chat/largePaste`)。正文里留着它们的 `[名字]` 占位符,
       *  两边合起来 agent 才知道哪句话在说哪个文件。不传就是没有附件。 */
      attachments?: Attachment[]
    }) => {
      if (!wsPath || !sessionId) throw new Error('没有选中会话')
      await invoke(CH.chatSend, [
        {
          workspacePath: wsPath,
          sessionId,
          agent: p.agent,
          agentLabel: p.agentLabel,
          model: p.model,
          text: p.text,
          attachments: p.attachments ?? [],
          source: '手机',
          permissionMode: p.permissionMode,
        },
      ])
    },
    [invoke, wsPath, sessionId],
  )

  const stop = useCallback(async () => {
    if (!wsPath) return
    await invoke(CH.chatStop, [{ workspacePath: wsPath, sessionId: sessionId ?? undefined }])
    setBusy(false)
  }, [invoke, wsPath, sessionId])

  return { msgs, loading, error, busy, send, stop }
}
