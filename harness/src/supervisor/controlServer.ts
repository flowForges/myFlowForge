import { startRpcServer } from '../kernel/rpcServer'
import { RpcError } from '../kernel/rpcError'
import { nullLogger, type Logger } from '../kernel/log'
import { HARNESS_VERSION } from '../kernel/version'
import type { Supervisor } from './supervisor'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import { applyAutostart, defaultExec, planAutostart, probeSystemdUser, type ExecFn } from '../platform/autostart'
import { dataDir as defaultDataDir } from '../protocol/paths'
import { ControlMethods } from '../protocol/rpc'

const ERR_METHOD_NOT_FOUND = -32601
const ERR_INVALID_PARAMS = -32602

export interface ControlServerOpts {
  addr: string
  token: string
  supervisor: Supervisor
  // 收到 shutdown 后的整套退出流程(默认只停监管);先回 ok 再执行
  onShutdown?: () => Promise<void> | void
  log?: Logger
  // 自启相关;测试注入以免碰真实系统
  exec?: ExecFn
  dataDir?: string
  home?: string
  platform?: NodeJS.Platform
  runningUnderLaunchd?: boolean
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
    handle: async (method, params) => {
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
        case 'autostart': {
          const parsed = ControlMethods.autostart.params.safeParse(params)
          if (!parsed.success) throw new RpcError(ERR_INVALID_PARAMS, 'invalid params for autostart')
          const { on, spec: given } = parsed.data
          // 演练模式(测试防线):不执行任何命令,且只允许写 home / 数据目录之内
          const dryRun = process.env.MFFAI_AUTOSTART_DRY_RUN === '1'
          const exec: ExecFn = dryRun ? async () => {} : (opts.exec ?? defaultExec)
          const home = opts.home ?? homedir()
          const platform = opts.platform ?? process.platform
          let errors: string[]
          try {
            const spec = { ...given, dataDir: opts.dataDir ?? process.env.MFFAI_DATA_DIR ?? defaultDataDir() }
            const plan = planAutostart(on ? 'install' : 'uninstall', spec, {
              platform,
              home,
              runningUnderLaunchd: opts.runningUnderLaunchd ?? process.env.XPC_SERVICE_NAME === 'com.myflowforge.mffai',
              uid: process.getuid?.(),
              hasSystemdUser: platform === 'linux' ? await probeSystemdUser(exec) : false,
            })
            const within = (p: string) => [home, spec.dataDir].some((r) => resolve(p) === resolve(r) || resolve(p).startsWith(resolve(r) + sep))
            const bad = dryRun ? [...plan.writes.map((w) => w.path), ...plan.removes].filter((p) => !within(p)) : []
            errors = bad.length ? bad.map((p) => `dry-run refuses path outside home: ${p}`) : (await applyAutostart(plan, exec)).errors
          } catch (err) {
            errors = [String(err)]
          }
          for (const e of errors) log.warn('autostart', { error: e })
          return { ok: errors.length === 0, errors }
        }
        default:
          throw new RpcError(ERR_METHOD_NOT_FOUND, `method not found: ${method}`)
      }
    },
  })
}
