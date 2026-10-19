import { LogConsole, type LogConsoleProps } from './LogConsole'
import { StatusBar, type StatusBarProps, type SbLogProps } from './StatusBar'
import type { LogStore } from '../state/logStore'
import { useLogSelector } from '../state/useLogs'

// ★ 日志 store 的订阅点。App 只把 store 往下递,自己不读日志 —— 日志一来,重渲的只有这两个组件,
// 而且各自只订阅自己用到的那一点:日志台要整份行列表,状态栏只要「有没有日志」「在不在跑」两个布尔。

export function LiveLogConsole({ store, ...rest }: Omit<LogConsoleProps, 'logs' | 'busy' | 'onClear'> & { store: LogStore }) {
  const logs = useLogSelector(store, s => s.logs)
  const busy = useLogSelector(store, s => s.busy)
  return <LogConsole {...rest} logs={logs} busy={busy} onClear={store.clear} />
}

export function LiveLogStatusBar({ store, sbLog, ...rest }: Omit<StatusBarProps, 'sbLog'> & {
  store: LogStore
  sbLog: Omit<SbLogProps, 'live' | 'has'>
}) {
  const live = useLogSelector(store, s => s.busy)
  const hasLogs = useLogSelector(store, s => s.logs.length > 0)
  return <StatusBar {...rest} sbLog={{ ...sbLog, live, has: hasLogs && !sbLog.open }} />
}
