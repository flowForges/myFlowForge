import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession } from '../agents/types'

export interface HookResult {
  ok: boolean
  output: string
  error?: string
}

// Run a plugin as a constrained micro-agent and capture its textual output, WITHOUT any
// RunState/RunStore coupling. Captures only `kind==='output'` log text (newline-joined) into
// `output` — every provider tags its final answer with kind:'output', so `level==='ok'` progress
// chatter is intentionally excluded to keep it out of the chained brief summaries. Treats an
// onState('err') OR a rejected session.done as failure (ok:false). The
// caller registers/cleans up activeSessions+heartbeater via the optional `onSession` hook.
//
// Mirrors orchestrator.runHook's prior `failed = hookAgent.state==='err' || !!errMsg`: `sawErr`
// stands in for the onState('err') that set hookAgent.state, and `error` for the caught exception.
export async function executeHook(
  provider: AgentProvider,
  task: AgentTask,
  cb: AgentCallbacks,
  env: NodeJS.ProcessEnv,
  hooks?: { onSession?: (s: AgentSession) => void },
): Promise<HookResult> {
  let captured = ''
  let sawErr = false
  const wrapped: AgentCallbacks = {
    ...cb,
    onLog: (line) => {
      if (line.kind === 'output') captured += (captured ? '\n' : '') + line.text
      cb.onLog(line)
    },
    onState: (s) => {
      if (s === 'err') sawErr = true
      cb.onState(s)
    },
  }

  let error: string | undefined
  let session: AgentSession | undefined
  try {
    session = provider.run(task, wrapped, env)
    hooks?.onSession?.(session)
    await session.done
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }

  return { ok: !error && !sawErr, output: captured, error: error || undefined }
}
