// 预览屏的夹具:数据照设计图(docs 的 _src/p_*.py)。每个任务往这里加自己屏的数据。
import type { FileDiff } from '@mffai/protocol'

export const PREVIEW_SIZE = { width: 1440, height: 826 } as const
export const PREVIEW_NARROW = { width: 1100, height: 726 } as const

/** 共用控件屏 */
export const UI_DIFF: FileDiff = {
  path: 'src/server/config.ts', status: 'M', binary: false, truncated: false,
  lines: [
    { kind: 'ctx', ln: 12, text: 'export const config = {' },
    { kind: 'del', ln: 13, text: '  retries: 3,' },
    { kind: 'add', ln: 13, text: '  retries: 5,' },
    { kind: 'add', ln: 14, text: '  backoffMs: 400,' },
    { kind: 'ctx', ln: 15, text: '}' },
  ],
}
export const UI_ROWS: readonly (readonly [string, string])[] = [['运行', 'r_7f3a'], ['改动', '3 个文件'], ['worktree', '~/work/forge-api']]
export const UI_TABLE = [
  { task: '修复登录超时', who: 'Codex', state: '运行中', time: '01:42' },
  { task: '更新依赖', who: 'Claude Code', state: '已合并', time: '06:10' },
  { task: '清理日志', who: 'Codex', state: 'timeout', time: '10:00' },
] as const
