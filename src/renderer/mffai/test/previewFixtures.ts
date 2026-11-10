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

export const PREVIEW_CHAT_NARROW = { width: 1100, height: 800 } as const

type Ev = (type: string, payload: Record<string, unknown>) => unknown

/** 03-chat-1/3/4:s1 开着的一轮,一个运行中的 Codex 委派、一个未隔离的 shell 待批、一个带 key 的待批 */
export function chatActiveEvents(e: Ev): unknown[] {
  const T = 't1'
  return [
    e('message.user', { turnId: T, text: '把 src/auth 里散落的 throw new Error 换成统一的 AuthError,再让 Codex 把单测补齐。' }),
    e('turn.snapshot', { turnId: T, phase: 'start', ref: 'refs/start' }),
    e('message.assistant', { turnId: T, step: 1, text: '我先把 `AuthError` 定义成带 `code` 字段的类,login、refresh、logout 三处共 9 个 `throw` 已经替换。现在跑一遍现有单测确认没有回归' }),
    e('executor.run.queued', { runId: 'r1', turnId: T, callId: 'c1', executor: 'Codex', summary: '为 AuthError 补齐单测', readOnly: false, isolation: 'wrapped', position: 1 }),
    e('executor.run.started', { runId: 'r1', turnId: T, executor: 'Codex', cwd: '~/work/forge-api', isolation: 'wrapped', untranslatedRules: 1 }),
    ...[['file', '读取 src/auth/errors.ts'], ['text', '编辑 test/auth/login.test.ts'], ['tool', '运行 pnpm vitest run test/auth'], ['think', '12 个用例通过,继续补边界情况'], ['text', '编辑 test/auth/errors.test.ts']]
      .map(([kind, text]) => e('executor.run.progress', { runId: 'r1', turnId: T, kind, text })),
    e('approval.requested', { approvalId: 'a1', turnId: T, callId: 'c2', tool: 'shell', summary: 'pnpm install --frozen-lockfile && pnpm vitest run src/auth --reporter=verbose', unsandboxed: true }),
    e('approval.requested', { approvalId: 'a2', turnId: T, callId: 'c3', tool: 'shell', summary: 'git stash push -m "pre-auth-refactor"', key: 'shell:git stash' }),
  ]
}

/** 03-chat-2:Telegram 会话 s2,第一轮已结束(两条已决、一条超时、一个结束了的 Claude Code 委派),第二轮挂起 */
export function chatTgEvents(e: Ev): unknown[] {
  return [
    e('message.user', { turnId: 't1', text: '今天线上 5xx 有点多,帮我看下是哪个服务' }),
    e('approval.requested', { approvalId: 'g1', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'kubectl logs deploy/gateway --since=2h' }),
    e('approval.resolved', { approvalId: 'g1', decision: 'allow', by: 'user', via: 'telegram:1' }),
    e('approval.requested', { approvalId: 'g2', turnId: 't1', callId: 'c2', tool: 'shell', summary: 'kubectl rollout restart deploy/gateway' }),
    e('approval.resolved', { approvalId: 'g2', decision: 'deny', by: 'user', via: 'telegram:1' }),
    e('approval.requested', { approvalId: 'g3', turnId: 't1', callId: 'c3', tool: 'http_get', summary: 'grafana.internal/api/ds/query' }),
    e('approval.resolved', { approvalId: 'g3', decision: 'deny', by: 'timeout' }),
    e('executor.run.started', { runId: 'r2', turnId: 't1', executor: 'Claude Code', cwd: 'im/ops-gateway', isolation: 'own', worktree: '~/.mff-ai/wt/r2' }),
    e('executor.run.ended', { runId: 'r2', turnId: 't1', executor: 'Claude Code', status: 'ok', ms: 192_000, exit: 0, usage: { input: 48200, output: 6100 }, violations: ['~/.npmrc'], changed: { files: ['config/pool.ts', 'test/pool.test.ts'], source: 'git', concurrent: true }, worktree: '~/.mff-ai/wt/r2', rawLog: '~/.mff-ai/runs/r_8f2c/raw.log' }),
    e('message.assistant', { turnId: 't1', step: 1, text: '`gateway` 在 09:40 之后 502 占比 4.1%,集中在 `/v2/orders`。我让 Claude Code 在 IM worktree 里排查连接池配置。' }),
    e('turn.ended', { turnId: 't1' }),
    e('message.user', { turnId: 't2', text: '连接池那个改动先合进去吧' }),
    e('message.assistant', { turnId: 't2', step: 1, text: '好,正在等合并结果' }),
    e('turn.parked', { turnId: 't2', step: 1, active: 1, pending: 0 }),
  ]
}
