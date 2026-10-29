import { readFileSync } from 'node:fs'
import {
  connectClient,
  connectControlClient,
  type ControlMethodName,
  type ControlParams,
  type ControlResult,
  type MffaiClient,
  type MffaiControlClient,
  type RuntimePaths,
} from '@mffai/protocol'

export type ConnectControl = typeof connectControlClient
export type ConnectWorker = typeof connectClient

export const CONTROL_TIMEOUT_MS = 3000
export const WORKER_TIMEOUT_MS = 5000

const TOKEN_RE = /^[0-9a-f]{64}$/

/** 后台生成的 token;还没生成 / 半截 → null */
export function readToken(file: string): string | null {
  try {
    const t = readFileSync(file, 'utf8').trim()
    return TOKEN_RE.test(t) ? t : null
  } catch {
    return null
  }
}

/** 控制口单次调用:连 → 调 → 断。连不上 / 无 token 抛错 */
export async function controlCall<M extends ControlMethodName>(
  connect: ConnectControl,
  paths: RuntimePaths,
  method: M,
  params?: ControlParams<M>,
): Promise<ControlResult<M>> {
  const token = readToken(paths.token)
  if (!token) throw new Error('no token')
  const c: MffaiControlClient = await connect({ addr: paths.controlAddr, token, timeoutMs: CONTROL_TIMEOUT_MS })
  try {
    return await c.call(method, params)
  } finally {
    c.close()
  }
}

export async function openWorker(connect: ConnectWorker, paths: RuntimePaths): Promise<MffaiClient> {
  const token = readToken(paths.token)
  if (!token) throw new Error('no token')
  return connect({ addr: paths.workerAddr, token, timeoutMs: WORKER_TIMEOUT_MS })
}
