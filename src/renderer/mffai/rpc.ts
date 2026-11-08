// 页面调后台只经这里(08 §6.3)。preload 拒绝时给的是普通对象 {name, code, message, data}
// (contextBridge 复制 Error 会丢掉 code、data),所以这里按字段取,不看 instanceof Error。
import type { WorkerMethodName, WorkerParams, WorkerResult } from '@mffai/protocol'

export class MffaiCallError extends Error {
  readonly code: number
  readonly data?: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'MffaiCallError'
    this.code = code
    if (data !== undefined) this.data = data
  }
}

/** 一次操作的 commandId:超时后用同一个重试才有回执重放 */
export const cmd = (): string => crypto.randomUUID()

/**
 * 同一个操作(key 相同:同一会话、同样的参数)失败后重试,用同一个 commandId,超时后的重试才有回执重放;
 * 成功后 done(key) 换新的。key 变了(参数改了)就是另一个操作
 */
export function retryable(): { id(key: string): string; done(key: string): void } {
  let cur: { key: string; id: string } | undefined
  return {
    id(key) {
      if (cur?.key !== key) cur = { key, id: cmd() }
      return cur.id
    },
    done(key) { if (cur?.key === key) cur = undefined },
  }
}

const ERR_INTERNAL = -32603
const ERR_METHOD_NOT_FOUND = -32601

export function toCallError(e: unknown): MffaiCallError {
  if (e instanceof MffaiCallError) return e
  const o = (e && typeof e === 'object' ? e : {}) as { code?: unknown; message?: unknown; data?: unknown }
  const message = typeof o.message === 'string' ? o.message : typeof e === 'string' ? e : ''
  return typeof o.code === 'number' ? new MffaiCallError(o.code, message, o.data) : new MffaiCallError(ERR_INTERNAL, message)
}

export async function call<M extends WorkerMethodName>(method: M, params?: WorkerParams<M>): Promise<WorkerResult<M>> {
  try {
    return await window.forge.mffai.call(method, params)
  } catch (e) {
    throw toCallError(e)
  }
}

/** 旧后台没有这个方法(-32601):页面显示「不支持」或干脆不显示 */
export function isUnsupported(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: unknown }).code === ERR_METHOD_NOT_FOUND
}
