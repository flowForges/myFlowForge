import { WorkerMethods, type WorkerMethodName } from '../protocol/index'

export type RpcHandler = (params: unknown) => Promise<unknown>

// 内核自己处理或属于传输层的方法,插件不能注册
const RESERVED = /^(?:auth|hello|status|snapshot|events\..+|session\..+)$/

/** 插件注册的工作进程 RPC 方法(每个方法只能有一个提供者) */
export class RpcRegistry {
  private handlers = new Map<string, { owner: string; handler: RpcHandler }>()

  register(owner: string, method: WorkerMethodName, handler: RpcHandler): () => void {
    if (!Object.hasOwn(WorkerMethods, method)) throw new Error(`unknown rpc method: ${method}`)
    if (RESERVED.test(method)) throw new Error(`rpc method ${method} is reserved by the kernel`)
    const prior = this.handlers.get(method)
    if (prior) throw new Error(`rpc method ${method} already registered by ${prior.owner}`)
    const entry = { owner, handler }
    this.handlers.set(method, entry)
    return () => {
      // 只撤销自己那一份
      if (this.handlers.get(method) === entry) this.handlers.delete(method)
    }
  }

  get(method: string): RpcHandler | undefined {
    return this.handlers.get(method)?.handler
  }
}
