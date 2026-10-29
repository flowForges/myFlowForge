// 事件总线:每个事件类型声明分发方式,用错方式直接抛错
export type DispatchMode = 'emit' | 'waterfall' | 'serial' | 'bail'

type Handler = (...args: any[]) => any

export class EventBus {
  private modes = new Map<string, DispatchMode>()
  private handlers = new Map<string, Handler[]>()

  declare(type: string, mode: DispatchMode): void {
    const old = this.modes.get(type)
    if (old && old !== mode) throw new Error(`event ${type} already declared as ${old}`)
    this.modes.set(type, mode)
  }

  on(type: string, handler: Handler, opts?: { prepend?: boolean }): () => void {
    const list = this.handlers.get(type) ?? []
    if (opts?.prepend) list.unshift(handler)
    else list.push(handler)
    this.handlers.set(type, list)
    return () => {
      const cur = this.handlers.get(type)
      const i = cur ? cur.indexOf(handler) : -1
      if (cur && i >= 0) cur.splice(i, 1)
    }
  }

  emit(type: string, ...args: unknown[]): void {
    this.check(type, 'emit')
    for (const h of this.snapshot(type)) {
      try {
        const r = h(...args)
        // emit 不等待,异步错误吞掉避免未处理拒绝
        if (r && typeof r.catch === 'function') r.catch(() => {})
      } catch {
        // 单个监听者失败不影响其他监听者
      }
    }
  }

  async waterfall<T>(type: string, value: T, ...args: unknown[]): Promise<T> {
    this.check(type, 'waterfall')
    const list = this.snapshot(type)
    const run = async (i: number, v: T): Promise<T> => {
      if (i >= list.length) return v
      return list[i](v, ...args, (nv: T) => run(i + 1, nv))
    }
    return run(0, value)
  }

  async serial(type: string, ...args: unknown[]): Promise<void> {
    this.check(type, 'serial')
    for (const h of this.snapshot(type)) await h(...args)
  }

  async bail<R>(type: string, ...args: unknown[]): Promise<R | undefined> {
    this.check(type, 'bail')
    for (const h of this.snapshot(type)) {
      const r = await h(...args)
      if (r !== undefined) return r as R
    }
    return undefined
  }

  private snapshot(type: string): Handler[] {
    return [...(this.handlers.get(type) ?? [])]
  }

  private check(type: string, used: DispatchMode): void {
    const mode = this.modes.get(type)
    if (!mode) throw new Error(`event ${type} is not declared`)
    if (mode !== used) throw new Error(`event ${type} is ${mode}`)
  }
}
