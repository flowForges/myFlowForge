import type { Plugin } from '../../kernel/pluginHost'
import { manifest } from './manifest'

// 联调用:把 prompt 原样回显,分两段流式输出
const loopEcho: Plugin = {
  manifest,
  activate(ctx) {
    ctx.events.on('session.prompt', async (req: { sessionId: string; turnId: string; text: string; signal: AbortSignal }) => {
      const { sessionId, turnId, text, signal } = req
      const full = `echo: ${text}`
      const mid = Math.ceil(full.length / 2)
      const ev = (type: 'turn.started' | 'message.assistant.delta' | 'message.assistant' | 'turn.ended', payload: unknown) =>
        ctx.append({ type, sessionId, payload })
      ev('turn.started', { turnId })
      for (const piece of [full.slice(0, mid), full.slice(mid)]) {
        if (signal.aborted) return true // 已取消:由内核补 turn.failed
        ev('message.assistant.delta', { turnId, text: piece })
      }
      if (signal.aborted) return true
      ev('message.assistant', { turnId, text: full })
      ev('turn.ended', { turnId })
      return true
    })
  },
}

export default loopEcho
