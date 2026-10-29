import { startRpcServer } from '../kernel/rpcServer'
import { RpcError } from '../kernel/rpcError'
import { nullLogger, type Logger } from '../kernel/log'
import { HARNESS_VERSION } from '../kernel/version'
import type { Supervisor } from './supervisor'

const ERR_METHOD_NOT_FOUND = -32601

export interface ControlServerOpts {
  addr: string
  token: string
  supervisor: Supervisor
  // 收到 shutdown 后的整套退出流程(默认只停监管);先回 ok 再执行
  onShutdown?: () => Promise<void> | void
  log?: Logger
}

/** 监管控制口(spec §5.2);独占监听即单实例锁,地址被占时抛 'address in use' */
export function startControlServer(opts: ControlServerOpts): Promise<{ close(): Promise<void> }> {
  const { supervisor } = opts
  const log = opts.log ?? nullLogger
  const later = (what: string, fn: () => unknown) =>
    setImmediate(() => void Promise.resolve().then(fn).catch((err) => log.error(`${what} failed`, { error: String(err) })))
  return startRpcServer({
    addr: opts.addr,
    token: opts.token,
    version: HARNESS_VERSION,
    handle: async (method) => {
      switch (method) {
        case 'status':
          return { ...supervisor.state(), pid: process.pid }
        case 'shutdown':
          later('shutdown', opts.onShutdown ?? (() => supervisor.shutdown()))
          return { ok: true }
        case 'restart':
          // 排空可能要 30 s,不让调用方等
          later('restart', () => supervisor.restart())
          return { ok: true }
        case 'resetTrip':
          supervisor.resetTrip()
          return { ok: true }
        default:
          // autostart 由 Task 8 实现
          throw new RpcError(ERR_METHOD_NOT_FOUND, `method not found: ${method}`)
      }
    },
  })
}
