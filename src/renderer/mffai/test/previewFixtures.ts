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

/** 对话页的会话列(_src/lib.py SESSIONS):组按 now 算,时间相对 now */
export function chatSessions(now: number) {
  const day = 86_400_000
  const at = (daysAgo: number, h: number, m = 0) => { const d = new Date(now - daysAgo * day); d.setHours(h, m, 0, 0); return d.getTime() }
  const s = (id: string, title: string, origin: string, updatedAt: number, patch: Record<string, unknown> = {}) =>
    ({ id, title, origin, audience: 'owner', approvalMode: 'ask', createdAt: 1, updatedAt, pendingApprovals: 0, ...patch })
  return [
    s('s1', '登录模块错误处理重构', 'app', now - 30_000, { cwd: '~/work/forge-api', pendingApprovals: 2, open: { turnId: 't', parked: false } }),
    s('s2', '看下今天的线上告警', 'im', now - 12 * 60_000, { open: { turnId: 't', parked: true } }),
    s('s3', '每日依赖安全巡检', 'schedule', at(0, 0, 1)),
    s('s4', '发布清单核对', 'im', at(1, 18), { audience: 'group' }),
    s('s5', 'README 翻译成英文', 'app', at(1, 10), { cwd: '~/work/forge-docs' }),
    s('s6', 'forge-api 补单测', 'acp', at(4, 10)),
    s('s7', '设计周报模板', 'app', at(4, 9)),
    s('s8', '周五清理 worktree', 'schedule', at(5, 9)),
    s('s9', '对比三家对象存储价格', 'app', at(7, 9)),
  ]
}
export const CHAT_TG = {
  chats: { chats: [{ chatId: '1', accountId: '1', sessionId: 's2', queued: 0, running: false }, { chatId: '2', accountId: '2', sessionId: 's4', queued: 0, running: false }], worktrees: [] },
  status: { state: 'online', enabled: true, tokenSet: true, secretsBackend: 'keychain', proxy: 'none', paired: [{ accountId: '1', name: '张伟', pairedAt: 1 }, { accountId: '2', name: '产品群', pairedAt: 1 }], pairing: { active: false }, dropped: { unpaired: 0, stale: 0, group: 0, attachment: 0, badUpdate: 0 }, undelivered: 0, problems: [] },
}
