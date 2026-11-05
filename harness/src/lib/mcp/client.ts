// 小型 MCP 客户端(stdio)。只用 initialize、tools/list、tools/call、ping;声明零能力。
// 服务发来的一切都是敌意输入:有界、有校验,服务的文字不进错误信息,instructions 直接丢弃。
import type { LineTransport } from './stdio'

export type McpErrorCode = 'init_timeout' | 'call_timeout' | 'protocol_error' | 'server_exited' | 'cancelled' | 'too_many_tools'

/** message 只有固定代码:服务的文字(可能含密钥)进不了错误 */
export class McpError extends Error {
  readonly code: McpErrorCode
  constructor(code: McpErrorCode) {
    super(code)
    this.name = 'McpError'
    this.code = code
  }
}

/** 字段都来自服务,没清洗过:当数据用,别当指令、别直接拼进提示(进模型前走 mcpResultBlock) */
export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
}

export interface McpClientOpts {
  timers: McpTimers
  initMs: number
  callMs: number
  clientInfo: { name: string; version: string }
  /** 无人认领的字节预算(默认 UNSOLICITED_BUDGET) */
  unsolicitedBudget?: number
}

export const DEFAULT_INIT_MS = 30_000
export const DEFAULT_CALL_MS = 120_000
/** 不是在答某个待决请求的字节(日志、通知、服务的请求、没人问的答复)。每有一个答复被认领就清零 */
export const UNSOLICITED_BUDGET = 64 * 1024 * 1024
export const MAX_DEPTH = 64
const MAX_ID_LENGTH = 64
export const PROTOCOL_VERSION = '2025-06-18'
export const MAX_TOOLS = 200
export const MAX_PAGES = 10
export const MAX_DESCRIPTION = 2000
export const MAX_SCHEMA_BYTES = 64 * 1024
export const MAX_ERROR_TEXT = 4000
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype'])
const VERSION_SHAPE = /^\d{4}-\d{2}-\d{2}$/

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

interface Pending {
  resolve(m: Obj): void
  reject(e: McpError): void
  timer: unknown
  detach(): void
}

const validName = (n: unknown): n is string => typeof n === 'string' && TOOL_NAME.test(n) && !RESERVED_NAMES.has(n)

function clip(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.charCodeAt(max - 1)
  return s.slice(0, cut >= 0xd800 && cut <= 0xdbff ? max - 1 : max)
}

/**
 * 迭代地量嵌套深度(递归会被深 JSON 打爆栈),并拔掉会让 stringify 或拷贝出事的键:toJSON、__proto__。
 * 深过 max 返回 false。JSON.parse 出来的对象才会走到这里
 */
function shallowEnough(root: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[root, 1]]
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!
    if (typeof v !== 'object' || v === null) continue
    if (depth > max) return false
    if (Array.isArray(v)) {
      for (const x of v) stack.push([x, depth + 1])
      continue
    }
    const o = v as Obj
    delete o.toJSON
    delete o.__proto__
    for (const k of Object.keys(o)) stack.push([o[k], depth + 1])
  }
  return true
}

function toolOf(raw: unknown): McpTool | undefined {
  if (!isObj(raw) || !validName(raw.name) || !isObj(raw.inputSchema)) return undefined
  if (!shallowEnough(raw.inputSchema, MAX_DEPTH)) return undefined
  if (Buffer.byteLength(JSON.stringify(raw.inputSchema)) > MAX_SCHEMA_BYTES) return undefined
  return { name: raw.name, description: typeof raw.description === 'string' ? clip(raw.description, MAX_DESCRIPTION) : '', inputSchema: raw.inputSchema }
}

/** marker:是我们写的占位,不是服务的文字;连着的同一个占位合成一行 */
function contentText(item: unknown): { t: string; marker: boolean } {
  const m = (t: string) => ({ t, marker: true })
  if (!isObj(item)) return m('[content omitted]')
  switch (item.type) {
    case 'text':
      return typeof item.text === 'string' ? { t: item.text, marker: false } : m('[content omitted]')
    case 'image':
      return m('[image omitted]')
    case 'audio':
      return m('[audio omitted]')
    case 'resource':
      return isObj(item.resource) && typeof item.resource.text === 'string' ? { t: item.resource.text, marker: false } : m('[resource omitted]')
    case 'resource_link':
      return m('[resource link omitted]')
    default:
      return m('[content omitted]')
  }
}

function joinContent(items: unknown[]): string {
  const runs: { t: string; marker: boolean; n: number }[] = []
  for (const item of items) {
    const c = contentText(item)
    const last = runs[runs.length - 1]
    if (c.marker && last?.marker && last.t === c.t) last.n++
    else runs.push({ ...c, n: 1 })
  }
  return runs.map(r => (r.n > 1 ? `${r.t.slice(0, -1)} x${r.n}]` : r.t)).join('\n')
}

export class McpClient {
  private readonly pending = new Map<number, Pending>()
  private nextId = 0
  private state: 'new' | 'ready' | 'failed' | 'closed' = 'new'
  private closeCode: McpErrorCode = 'server_exited'
  private cache: McpTool[] | undefined
  private generation = 0
  private timeouts = 0
  private unsolicited = 0

  constructor(
    private readonly t: LineTransport,
    private readonly o: McpClientOpts,
  ) {
    t.onMessage((m, bytes) => this.onMessage(m, bytes))
    t.onJunk(bytes => this.spend(bytes))
    t.onClose(why => this.onClose(why === 'overflow' ? 'protocol_error' : 'server_exited'))
  }

  /** 连续没回的调用数;任何答复清零。杀进程的决定在调用方 */
  get consecutiveTimeouts(): number {
    return this.timeouts
  }

  async initialize(): Promise<void> {
    if (this.state === 'closed') throw new McpError(this.closeCode)
    if (this.state !== 'new') throw new McpError('protocol_error')
    this.state = 'failed'
    const res = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: this.o.clientInfo }, this.o.initMs)
    const r = res.result
    if (!isObj(r) || typeof r.protocolVersion !== 'string' || !VERSION_SHAPE.test(r.protocolVersion)) throw new McpError('protocol_error')
    // instructions 是往上下文塞话的入口:不读、不存
    if (this.state !== 'failed') throw new McpError(this.closeCode)
    this.t.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    this.state = 'ready'
  }

  /** 整个翻页过程有一个总期限(callMs),signal 能随时取消;每一页另有自己的超时 */
  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    this.requireReady()
    if (this.cache) return [...this.cache]
    if (signal?.aborted) throw new McpError('cancelled')
    const gen = this.generation
    const inner = new AbortController()
    let timedOut = false
    const deadline = this.o.timers.setTimeout(() => {
      timedOut = true
      this.timeouts++
      inner.abort()
    }, this.o.callMs)
    const onAbort = () => inner.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const out = await this.fetchPages(inner.signal)
      if (gen === this.generation) this.cache = out
      return [...out]
    } catch (e) {
      if (timedOut && e instanceof McpError && e.code === 'cancelled') throw new McpError('call_timeout')
      throw e
    } finally {
      this.o.timers.clearTimeout(deadline)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async fetchPages(signal: AbortSignal): Promise<McpTool[]> {
    const out: McpTool[] = []
    const names = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    let raw = 0
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw new McpError('too_many_tools')
      const res = await this.request('tools/list', cursor === undefined ? undefined : { cursor }, this.o.callMs, signal)
      const r = res.result
      if (!isObj(r) || !Array.isArray(r.tools)) throw new McpError('protocol_error')
      raw += r.tools.length
      if (raw > MAX_TOOLS) throw new McpError('too_many_tools')
      for (const item of r.tools) {
        const tool = toolOf(item)
        if (tool && !names.has(tool.name)) {
          names.add(tool.name)
          out.push(tool)
        }
      }
      const next = r.nextCursor
      if (next === undefined || next === null || next === '') return out
      if (typeof next !== 'string' || cursors.has(next)) throw new McpError('protocol_error')
      cursors.add(next)
      cursor = next
    }
  }

  async callTool(name: string, args: unknown, signal: AbortSignal): Promise<{ text: string; isError: boolean }> {
    this.requireReady()
    if (!validName(name)) throw new McpError('protocol_error')
    if (signal.aborted) throw new McpError('cancelled')
    const res = await this.request('tools/call', { name, arguments: args }, this.o.callMs, signal)
    if (res.error !== undefined) {
      const e = res.error
      if (!isObj(e)) throw new McpError('protocol_error')
      const text = typeof e.message === 'string' ? clip(e.message, MAX_ERROR_TEXT) : `error${typeof e.code === 'number' && Number.isFinite(e.code) ? ` ${e.code}` : ''}`
      return { text, isError: true }
    }
    const r = res.result
    if (!isObj(r)) throw new McpError('protocol_error')
    if (r.content !== undefined && !Array.isArray(r.content)) throw new McpError('protocol_error')
    const items = r.content ?? []
    let text: string
    if (items.length === 0 && r.structuredContent !== undefined) {
      if (!shallowEnough(r.structuredContent, MAX_DEPTH)) throw new McpError('protocol_error')
      text = JSON.stringify(r.structuredContent)
    } else text = joinContent(items)
    return { text, isError: r.isError === true }
  }

  close(): void {
    this.shut('server_exited')
    this.t.close()
  }

  private requireReady(): void {
    if (this.state === 'closed') throw new McpError(this.closeCode)
    if (this.state !== 'ready') throw new McpError('protocol_error')
  }

  private shut(code: McpErrorCode): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.closeCode = code
    this.cache = undefined
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id)
      this.o.timers.clearTimeout(p.timer)
      p.detach()
      p.reject(new McpError(code))
    }
  }

  private onClose(code: McpErrorCode): void {
    this.shut(code)
  }

  /** 解出来的是整条答复(result 或 error 二选一),由各调用方按自己的方式看 */
  private request(method: string, params: unknown, ms: number, signal?: AbortSignal): Promise<Obj> {
    return new Promise<Obj>((resolve, reject) => {
      const id = ++this.nextId
      const settle = (p: Pending) => {
        this.o.timers.clearTimeout(p.timer)
        p.detach()
      }
      const cancel = (why: 'timeout' | 'abort') => {
        const p = this.pending.get(id)
        if (!p) return
        this.pending.delete(id)
        settle(p)
        this.t.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: why === 'timeout' ? 'timeout' : 'cancelled' } })
        if (why === 'timeout') this.timeouts++
        reject(new McpError(why === 'timeout' ? 'call_timeout' : 'cancelled'))
      }
      const p: Pending = { resolve, reject, timer: undefined, detach: () => {} }
      p.timer = this.o.timers.setTimeout(() => {
        if (method === 'initialize') {
          if (this.pending.delete(id)) {
            settle(p)
            reject(new McpError('init_timeout'))
          }
        } else cancel('timeout')
      }, ms)
      if (signal) {
        const onAbort = () => cancel('abort')
        signal.addEventListener('abort', onAbort, { once: true })
        p.detach = () => signal.removeEventListener('abort', onAbort)
      }
      this.pending.set(id, p)
      this.t.send({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) })
    })
  }

  /** 无人认领的字节记账;超了预算就放弃整条流 */
  private spend(bytes: number): void {
    this.unsolicited += bytes
    if (this.unsolicited > (this.o.unsolicitedBudget ?? UNSOLICITED_BUDGET)) this.t.overflow()
  }

  // jsonrpc 字段不校验:各家服务写得不一,拒了只会少兼容几个;安全不靠它,靠 id 必须是我们发出过的整数
  private onMessage(m: Obj, bytes: number): void {
    if (typeof m.method === 'string') {
      this.spend(bytes)
      return this.onIncoming(m.method, m)
    }
    const id = m.id
    const p = typeof id === 'number' ? this.pending.get(id) : undefined
    if (!p || typeof id !== 'number') return this.spend(bytes)
    this.unsolicited = 0
    this.pending.delete(id)
    this.o.timers.clearTimeout(p.timer)
    p.detach()
    this.timeouts = 0
    if (m.error !== undefined) {
      if (!isObj(m.error)) return p.reject(new McpError('protocol_error'))
      return p.resolve({ error: m.error })
    }
    if (m.result === undefined) return p.reject(new McpError('protocol_error'))
    p.resolve({ result: m.result })
  }

  private onIncoming(method: string, m: Obj): void {
    const id = m.id
    if (id === undefined) {
      if (method === 'notifications/tools/list_changed') {
        this.generation++
        this.cache = undefined
      }
      return
    }
    if (typeof id === 'string' ? id.length > MAX_ID_LENGTH : !(typeof id === 'number' && Number.isFinite(id))) return
    // 服务不读 stdin、只管灌请求时,回复会把我们的内存撑满:排着队就不回
    if (this.t.congested) return
    if (method === 'ping') this.t.send({ jsonrpc: '2.0', id, result: {} })
    else this.t.send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
  }
}
