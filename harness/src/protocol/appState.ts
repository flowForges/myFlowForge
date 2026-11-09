import type { ControlStatus, SandboxStatus } from './rpc'

/** app 主进程 → 渲染层的 mff-ai 状态(`mffai:state`) */
export interface MffaiState {
  enabled: boolean
  autostart: boolean
  running: boolean
  supervisor?: ControlStatus
  compatible?: boolean
  rssMb?: number
  /** 已激活插件数(worker status 里 state==='active' 的个数) */
  pluginsActive?: number
  dataDir?: string
  /** 05:worker status 里的沙箱状态(旧后台没有) */
  sandbox?: SandboxStatus
  /** 08 §5.3:宿主正在做的串行操作;有它时状态条不显示"重新启动" */
  op?: 'enable' | 'disable' | 'restart' | 'resetTrip' | 'ensure'
  /** 后台是这个宿主拉起的,而设置里的代理已经改了 */
  proxyStale?: true
  /** 数据目录还在(停用后的启用卡片用) */
  dataExists?: boolean
  /** 主进程算好的根目录和钥匙串账号(评审修订 R14:渲染层不算);launchAgent:删除全部数据会删的这个数据目录自己的 plist,在才有 */
  roots?: { data: string; worktrees: string; imWorktrees: string; plugins: string; keychain: string; launchAgent?: string }
}

/** `mffai:alert` 载荷 → 通知铃铛 */
export type MffaiAlert =
  | { kind: 'incompatible' }
  | { kind: 'tripped'; reason: 'crash-loop' | 'oom' }
  | { kind: 'restarting' }
  /** 08 §8.1(R11):events.subscribe 回了 reset,页面丢掉缓存全部重取;铃铛不为它出通知 */
  | { kind: 'reset' }
