import {
  PROTOCOL_VERSION,
  type ControlStatus,
  type MffaiAlert,
  type MffaiClient,
  type RuntimePaths,
} from '@mffai/protocol'
import { CH } from '../ipc/channels'
import { openWorker, type ConnectWorker } from './client'

const RECONNECT_EVERY_MS = 1000
const RECONNECT_FOR_MS = 30_000

export interface ConnectionOpts {
  paths: RuntimePaths
  connectWorker: ConnectWorker
  clientVersion: string
  send(ch: string, payload: unknown): void
  status(): Promise<ControlStatus | undefined>
  now(): number
  sleep(ms: number): Promise<void>
  log(msg: string, err?: unknown): void
  /** 订阅回了 reset(数据目录被换过) */
  onReset(): void
}

export const isOldProtocol = (s?: ControlStatus): boolean => !!s && s.protocolVersion !== PROTOCOL_VERSION

/**
 * 工作进程连接:hello 版本握手、订阅并转发事件、断线补齐。
 * 连着时 socket 断开 → alert restarting,每 1 s 重连、最多 30 s(控制口 restarting / starting 期间);
 * 控制口报 tripped → alert tripped 并停止。
 */
export function createWorkerConnection(o: ConnectionOpts) {
  let worker: MffaiClient | undefined
  let compatible: boolean | undefined
  let lastSeq: number | undefined
  let wanted = false // false:主动断开之后,断线不重连
  let connectP: Promise<void> | undefined

  const alert = (a: MffaiAlert) => o.send(CH.mffaiAlert, a)
  const tripped = (s: ControlStatus) => alert({ kind: 'tripped', reason: s.trippedReason ?? 'crash-loop' })
  const markIncompatible = () => {
    compatible = false
    alert({ kind: 'incompatible' })
  }

  async function doConnect(): Promise<void> {
    const w = await openWorker(o.connectWorker, o.paths)
    try {
      const hello = await w.call('hello', { clientVersion: o.clientVersion, protocolVersion: PROTOCOL_VERSION })
      if (!hello.compatible) {
        w.close()
        return markIncompatible()
      }
      if (lastSeq === undefined) lastSeq = (await w.call('snapshot')).lastSeq
      w.onEvent((e) => {
        if (e.seq > (lastSeq ?? 0)) lastSeq = e.seq
        o.send(CH.mffaiEvent, e)
      })
      const sub = await w.call('events.subscribe', { after: lastSeq })
      if ('reset' in sub) {
        // 对方的日志比我们见过的短:从它的 lastSeq 重新起订
        lastSeq = sub.lastSeq
        o.onReset()
        await w.call('events.subscribe', { after: lastSeq })
      }
    } catch (err) {
      w.close()
      throw err
    }
    compatible = true
    worker = w
    w.onClose(() => {
      if (worker !== w) return
      worker = undefined
      if (wanted) onDropped()
    })
  }
  const connect = (): Promise<void> => {
    wanted = true
    if (worker) return Promise.resolve()
    return (connectP ??= doConnect().finally(() => { connectP = undefined }))
  }

  function onDropped(): void {
    alert({ kind: 'restarting' })
    void reconnect().catch((err) => o.log('mffai reconnect failed', err))
  }
  async function reconnect(): Promise<void> {
    const end = o.now() + RECONNECT_FOR_MS
    while (wanted && !worker && o.now() < end) {
      await o.sleep(RECONNECT_EVERY_MS)
      if (!wanted || worker) return
      const s = await o.status()
      if (!s || s.state === 'stopping' || isOldProtocol(s)) return
      if (s.state === 'tripped') return tripped(s)
      if (s.state === 'running') {
        try {
          return await connect()
        } catch { /* 下一秒再试 */ }
      }
    }
  }

  return {
    connect,
    current: (): MffaiClient | undefined => worker,
    compatible: (): boolean | undefined => compatible,
    markIncompatible,
    tripped,
    /** 清掉版本判定(换了新后台之后) */
    resetCompat(): void { compatible = undefined },
    /** 主动断开:不触发 restarting,也不重连 */
    drop(): void {
      wanted = false
      const w = worker
      worker = undefined
      w?.close()
    },
  }
}
