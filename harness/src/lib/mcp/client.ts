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
}

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

function toolOf(raw: unknown): McpTool | undefined {
  if (!isObj(raw) || !validName(raw.name) || !isObj(raw.inputSchema)) return undefined
  if (Buffer.byteLength(JSON.stringify(raw.inputSchema)) > MAX_SCHEMA_BYTES) return undefined
  return { name: raw.name, description: typeof raw.description === 'string' ? clip(raw.description, MAX_DESCRIPTION) : '', inputSchema: raw.inputSchema }
}

function contentText(item: unknown): string {
  if (!isObj(item)) return '[content omitted]'
  switch (item.type) {
    case 'text':
      return typeof item.text === 'string' ? item.text : '[content omitted]'
    case 'image':
      return '[image omitted]'
    case 'audio':
      return '[audio omitted]'
    case 'resource':
      return isObj(item.resource) && typeof item.resource.text === 'string' ? item.resource.text : '[resource omitted]'
    case 'resource_link':
      return '[resource link omitted]'
    default:
      return '[content omitted]'
  }
}

export class McpClient {
  private readonly pending = new Map<number, Pending>()
  private nextId = 0
  private state: 'new' | 'ready' | 'failed' | 'closed' = 'new'
  private closeCode: McpErrorCode = 'server_exited'
  private cache: McpTool[] | undefined
  private generation = 0
  private timeouts = 0

  constructor(
    private readonly t: LineTransport,
    private readonly o: McpClientOpts,
  ) {
    t.onMessage(m => this.onMessage(m))
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

  async listTools(): Promise<McpTool[]> {
    this.requireReady()
    if (this.cache) return [...this.cache]
    const gen = this.generation
    const out: McpTool[] = []
    const names = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    let raw = 0
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw new McpError('too_many_tools')
      const res = await this.request('tools/list', cursor === undefined ? undefined : { cursor }, this.o.callMs)
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
      if (next === undefined || next === null || next === '') break
      if (typeof next !== 'string' || cursors.has(next)) throw new McpError('protocol_error')
      cursors.add(next)
      cursor = next
    }
    if (gen === this.generation) this.cache = out
    return [...out]
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
    const text = items.length === 0 && r.structuredContent !== undefined ? JSON.stringify(r.structuredContent) : items.map(contentText).join('\n')
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

  private onMessage(m: Obj): void {
    if (typeof m.method === 'string') return this.onIncoming(m.method, m)
    const id = m.id
    if (typeof id !== 'number') return
    const p = this.pending.get(id)
    if (!p) return
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
    if (typeof id !== 'string' && !(typeof id === 'number' && Number.isFinite(id))) return
    if (method === 'ping') this.t.send({ jsonrpc: '2.0', id, result: {} })
    else this.t.send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
  }
}
