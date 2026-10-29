// 协议层错误:由传输层转成 JSON-RPC error
export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message)
    this.name = 'RpcError'
  }
}
