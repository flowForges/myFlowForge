// Bot API 客户端(07 spec §5.1):唯一碰令牌和 fetch 的地方。令牌只能放 URL 里,所以 URL 不出这个文件:
// 网络层的原始错误、正文解析错误、Response 一律不外传,对外只有稳定代码

export type TelegramErrorCode =
  | 'unauthorized'
  | 'conflict_webhook'
  | 'conflict_other'
  | 'rate_limited'
  | 'network'
  | 'server'
  | 'bad_request'
  | 'blocked'
  | 'not_found_message'
  | 'not_modified'
  | 'aborted'

/** message 就是 code;没有 cause,没有 URL,没有服务器的 description */
export class TelegramError extends Error {
  declare readonly retryAfter?: number

  constructor(
    readonly code: TelegramErrorCode,
    retryAfter?: number,
  ) {
    super(code)
    if (retryAfter !== undefined) this.retryAfter = retryAfter
  }
}
TelegramError.prototype.name = 'TelegramError'

export interface ApiTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface CallOpts {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface TelegramApi {
  call<T>(method: string, body: object, opts?: CallOpts): Promise<T>
}

export interface CreateApiOpts {
  base: string
  token: () => string | undefined
  fetch?: typeof fetch
  timeoutMs?: number
  timers?: ApiTimers
}

const DEFAULT_TIMEOUT_MS = 30_000
/** 100 条更新也到不了这么大;对面发个没完,内存不能跟着涨 */
export const MAX_BODY_BYTES = 16 * 1024 * 1024
/** 再小的 retry_after 也不能变成毫秒级的重试 */
const MIN_RETRY_AFTER_S = 1

export const REAL_TIMERS: ApiTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
}

/** 只读这几个字段;别的形状都当没有 */
interface Reply {
  ok: unknown
  result: unknown
  description: string
  retryAfter?: number
}

function parseReply(text: string): Reply {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    raw = undefined
  }
  const o = (raw && typeof raw === 'object' ? raw : {}) as { ok?: unknown; result?: unknown; description?: unknown; parameters?: { retry_after?: unknown } | null }
  const retryAfter = o.parameters?.retry_after
  return {
    ok: o.ok,
    result: o.result,
    description: typeof o.description === 'string' ? o.description : '',
    ...(typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0 && { retryAfter: Math.max(retryAfter, MIN_RETRY_AFTER_S) }),
  }
}

/** spec §5.2、§5.4。description 只用来分类 */
function errorFor(status: number, reply: Reply): TelegramError {
  if (status === 401 || status === 404) return new TelegramError('unauthorized')
  if (status === 403) return new TelegramError('blocked')
  if (status === 409) return new TelegramError(/webhook/i.test(reply.description) ? 'conflict_webhook' : 'conflict_other')
  if (status === 429) return new TelegramError('rate_limited', reply.retryAfter)
  if (status === 400) {
    if (/not modified/i.test(reply.description)) return new TelegramError('not_modified')
    if (/message to edit not found/i.test(reply.description)) return new TelegramError('not_found_message')
    return new TelegramError('bad_request')
  }
  if (status >= 400 && status < 500) return new TelegramError('bad_request')
  return new TelegramError('server')
}

/** 到上限就取消:连接断开,后面的不再读 */
async function readBody(res: Response): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return Buffer.concat(chunks).toString('utf8')
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      void reader.cancel().catch(() => {})
      throw new TelegramError('network')
    }
    chunks.push(value)
  }
}

export function createApi(o: CreateApiOpts): TelegramApi {
  const doFetch: typeof fetch = o.fetch ?? ((input, init) => fetch(input, init))
  const timers = o.timers ?? REAL_TIMERS
  const defaultTimeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const currentToken = (): string => {
    let token: string | undefined
    try {
      token = o.token()
    } catch {
      token = undefined
    }
    if (!token) throw new TelegramError('unauthorized')
    return token
  }

  const serialize = (body: object): string => {
    try {
      return JSON.stringify(body)
    } catch {
      throw new TelegramError('bad_request')
    }
  }

  const request = async (url: string, payload: string, signal: AbortSignal): Promise<unknown> => {
    let status: number
    let text: string
    try {
      const res = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, redirect: 'error', signal })
      status = res.status
      text = await readBody(res)
    } catch {
      throw new TelegramError('network')
    }
    if (status === 0 || (status >= 300 && status < 400)) throw new TelegramError('network')
    const reply = parseReply(text)
    if (status < 200 || status >= 300) throw errorFor(status, reply)
    if (reply.ok !== true || reply.result === undefined) throw new TelegramError('server')
    return reply.result
  }

  return {
    async call<T>(method: string, body: object, opts: CallOpts = {}): Promise<T> {
      const { signal } = opts
      if (signal?.aborted) throw new TelegramError('aborted')
      const url = `${o.base}/bot${currentToken()}/${method}`
      const payload = serialize(body)
      const ctl = new AbortController()
      let timer: unknown
      let onAbort = () => {}
      // 和请求赛跑,不靠 fetch 认 signal;先定结果再 abort,fetch 自己的错永远赢不了。输掉的那个 rejection 由 race 接住
      const interrupted = new Promise<never>((_, reject) => {
        const interrupt = (code: TelegramErrorCode) => {
          reject(new TelegramError(code))
          ctl.abort()
        }
        timer = timers.setTimeout(() => interrupt('network'), opts.timeoutMs ?? defaultTimeoutMs)
        onAbort = () => interrupt('aborted')
        signal?.addEventListener('abort', onAbort, { once: true })
      })
      try {
        return (await Promise.race([request(url, payload, ctl.signal), interrupted])) as T
      } finally {
        timers.clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}
