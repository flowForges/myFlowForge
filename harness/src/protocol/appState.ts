import type { ControlStatus } from './rpc'

/** app 主进程 → 渲染层的 mff-ai 状态(`mffai:state`) */
export interface MffaiState {
  enabled: boolean
  autostart: boolean
  running: boolean
  supervisor?: ControlStatus
  compatible?: boolean
  rssMb?: number
  dataDir?: string
}

/** `mffai:alert` 载荷 → 通知铃铛 */
export type MffaiAlert =
  | { kind: 'incompatible' }
  | { kind: 'tripped'; reason: 'crash-loop' | 'oom' }
  | { kind: 'restarting' }
