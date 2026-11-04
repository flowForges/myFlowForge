// 记忆注入(06 spec §7):块写进 memory.injected,历史只从事件重建,所以文件怎么变都动不了已发的字节。
// 两个循环共用;日志用结构类型,lib/ 不碰 kernel/
import type { KernelEvent } from '../../protocol/index'
import type { ContextBlock, MemoryService } from './types'

export type InjectRequest = Parameters<MemoryService['contextFor']>[0]
export type InjectedPayload = { turnId: string } & ContextBlock

/** 记忆坏了不影响这一轮:contextFor 和写事件的失败都只记日志。错误信息可能引用记忆文本,只留类型 */
export function injectMemory(memory: MemoryService, req: InjectRequest, append: (payload: InjectedPayload) => unknown, log: { warn(msg: string, data?: object): void }): void {
  try {
    for (const block of memory.contextFor(req)) append({ turnId: req.turnId, ...block })
  } catch (err) {
    log.warn('memory injection failed', { turnId: req.turnId, error: err instanceof Error ? err.name : 'unknown' })
  }
}

const isString = (v: unknown): v is string => typeof v === 'string'

/**
 * 历史要用的块。session 是日志里第一个会话块,所在的轮回滚了也算:回滚不改变它的位置。
 * 一轮一个轮块,先写的算:发出去的就是它
 */
export function blocksOf(events: KernelEvent[]): { session?: string; turns: Map<string, string> } {
  let session: string | undefined
  const turns = new Map<string, string>()
  for (const e of events) {
    if (e.type !== 'memory.injected') continue
    const p = e.payload as { turnId?: unknown; kind?: unknown; text?: unknown } | null
    if (!isString(p?.text) || !isString(p.turnId)) continue
    if (p.kind === 'session') session ??= p.text
    else if (p.kind === 'turn' && !turns.has(p.turnId)) turns.set(p.turnId, p.text)
  }
  return { ...(session !== undefined && { session }), turns }
}
