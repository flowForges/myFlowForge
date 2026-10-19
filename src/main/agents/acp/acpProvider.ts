import { appLog } from '../../log/appLog'
import type { AgentCallbacks, AgentSession, AgentTask, ChatCallbacks, ChatTask } from '../types'
import { chatWithAcpFallback, type AcpChatOptions } from './acpChat'

// ── 「只有 run()」的 provider 接 ACP 聊天的那一层 ───────────────────────────────────────────
//
// gemini / qwen / copilot / kimi 的 chat() 都长这样:先走 `<bin> <ACP 开关>`,握手没成就透明回落到
// 它们老的 run() 聊天(chatService 原来那条「降级」路的同一套映射,只是挪到了 provider 里)。

export interface AcpProviderChatSpec {
  bin: string
  /** 这一轮的 ACP 启动参数(带 provider 自己的 ACP 开关、审批档、模型)。 */
  args: (task: ChatTask) => string[]
  /** 起 ACP agent 前对 env 的修整(比如去掉会让 CLI 自己全放行的环境变量)。不改传进来的那份。 */
  env?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
  /** 回落:provider 自己的 run()。 */
  run: (task: AgentTask, cb: AgentCallbacks, env: NodeJS.ProcessEnv) => AgentSession
  /** 测试缝:换掉起进程那一步。 */
  acp?: Pick<AcpChatOptions, 'open' | 'handshakeMs'>
}

/**
 * ★★ACP 会话**不续接**:每轮都 session/new,也不把 ACP 会话 id 报给 chatService。
 *
 *  chatService 的上下文续接是「三选一」:没有原生会话 → 整段本地历史前导;有原生会话但不可信 →
 *  照样整段前导;只有 claude 的 resume 可信才什么都不带。它在 chat() **之前**就把前导拼进 prompt 了,
 *  而 session/load 成没成要到 chat() 里面才知道 —— 想「load 成功就不带前导」得把拼 prompt 的时机挪进
 *  provider,这是对 chatService 的大改。反过来,如果把 id 报上去又去 load:
 *   ① load 成功 + 前导 = 历史发两遍;
 *   ② 有了 id,下次切回来时 chatService 会走「水位之后的增量前导」—— 可一旦 load 失败(agent 把会话
 *      清掉了、换了机器)就是新会话 + 半截历史,静默丢上下文。
 *  所以最简单也正确的做法:不报 id(chatService 眼里它永远「没有原生会话」→ 每轮整段本地历史),
 *  也不传 id 给 runAcpChat(→ 每轮 session/new)。和这些 provider 以前走 run() 降级时的上下文行为一模一样。
 */
export function acpProviderChat(spec: AcpProviderChatSpec) {
  return (task: ChatTask, cb: ChatCallbacks, env: NodeJS.ProcessEnv): AgentSession => {
    const acpEnv = spec.env ? spec.env({ ...env }) : env
    return chatWithAcpFallback(
      { bin: spec.bin, args: spec.args(task), env: acpEnv, cwd: task.cwd },
      { ...task, sessionId: undefined },
      { ...cb, onSession: () => {} },
      () => runAsChat(spec.run, task, cb, env),
      {
        ...spec.acp,
        onFallback: (err) => appLog('warn', 'acp', `${spec.bin} 讲不了 ACP,本轮回落到 run()`, err.message),
      },
    )
  }
}

/**
 * 用 run() 跑一轮聊天,输出映射回 ChatCallbacks —— 和 chatService 给「没有 chat() 的 provider」的那条
 * 降级路一字不差:只有 ok / accent(正文)行算回复,行与行之间补换行;run 收尾(不论退出码)= 这一轮结束。
 */
export function runAsChat(run: AcpProviderChatSpec['run'], task: ChatTask, cb: ChatCallbacks, env: NodeJS.ProcessEnv): AgentSession {
  const start = Date.now()
  let wrote = false
  let ended = false
  const end = (f: () => void) => { if (ended) return; ended = true; f() }
  const session = run(
    { stageKey: 'chat', agentId: task.id, name: 'chat', prompt: task.prompt, cwd: task.cwd, model: task.model },
    {
      onLog: (l) => {
        if (!(l.level === 'ok' || (l.level === 'accent' && (l.kind === 'output' || l.kind == null)))) return
        cb.onAssistantDelta(wrote ? `\n${l.text}` : l.text)
        wrote = true
      },
      onState: () => {},
      onActivity: () => cb.onActivity?.(),
      onUsage: (u) => cb.onUsage?.(u),
      onTurnTokens: (t) => cb.onTurnTokens?.(t),
      onConfirm: (req) => cb.onConfirm ? cb.onConfirm(req) : Promise.resolve('deny'),
      onInput: async () => '',
      onDone: () => {},
      onError: (err) => end(() => cb.onError(err)),
    },
    env,
  )
  const done = session.done.then(
    (r) => { end(() => cb.onDone({ elapsed: Math.round((Date.now() - start) / 1000) })); return r },
    (e: unknown) => { const err = e instanceof Error ? e : new Error(String(e)); end(() => cb.onError(err)); return { ok: false, summary: err.message } },
  )
  return { id: session.id, cancel: () => session.cancel(), done }
}
