import type { KernelEvent } from '../protocol/index'

// 推给客户端的视图(events.tail 与 events.subscribe 推送);事件日志本身保持完整

export const WIRE_CONTENT_MAX = 2000

function cut(s: string): string {
  let end = WIRE_CONTENT_MAX
  const c = s.charCodeAt(end - 1)
  if (c >= 0xd800 && c <= 0xdbff) end-- // 不劈开代理对
  return s.slice(0, end)
}

export function toWire(e: KernelEvent): KernelEvent {
  const p = e.payload as Record<string, unknown> | null
  if (!p || typeof p !== 'object') return e
  if (e.type === 'tool.ended') {
    if (typeof p.content !== 'string' || p.content.length <= WIRE_CONTENT_MAX) return e
    return { ...e, payload: { ...p, content: cut(p.content), truncated: true } }
  }
  if (e.type === 'message.assistant' && Array.isArray(p.parts)) {
    const has = (x: unknown) => !!x && typeof x === 'object' && (x as { type?: unknown }).type === 'reasoning' && 'replay' in x
    if (!p.parts.some(has)) return e
    const parts = p.parts.map(x => {
      if (!has(x)) return x
      const { replay: _r, ...rest } = x as Record<string, unknown>
      return rest
    })
    return { ...e, payload: { ...p, parts } }
  }
  return e
}
