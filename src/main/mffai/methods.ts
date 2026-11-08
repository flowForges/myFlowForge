import { WorkerMethods, type WorkerMethodName } from '@mffai/protocol'

// mffai:call 的方法表(08 §5.1)。ipc.ts 在加载 host 之前就要用,所以不放在 host.ts 里。

/** 不走 mffai:call 的方法:传输层的握手和订阅,以及要开浏览器的 ChatGPT 登录(走现有通道) */
export const CALL_EXCLUDED: ReadonlySet<string> = new Set(['auth.challenge', 'auth.verify', 'hello', 'events.subscribe', 'auth.chatgpt.begin'])

const LONG_MS = 120_000
const LONGEST_MS = 600_000
const LONG_NAMED = [
  'turn.rollback', 'turn.diff', 'channel.telegram.setToken', 'memory.delete', 'memory.deleteMany', 'memory.file.set',
  'memory.proposals.decide', 'session.delete', 'plugins.install.confirm', 'plugins.uninstall', 'plugins.upgrade.prepare',
  'plugins.store.discard', 'models.addAccount', 'models.testAccount', 'permissions.set',
]
const isLong = (m: string) => LONG_NAMED.includes(m) || (m.startsWith('executor.') && m !== 'executor.list') ||
  m.startsWith('channel.telegram.worktree.') || m.startsWith('plugins.dev.')
/**
 * 长调用的期限(08 §5.1)。session.delete / memory.deleteMany 要扫整个日志再 VACUUM,
 * 超时后页面用同一个 commandId 重试,回执去重。其余用连接默认的 5 s
 */
export const LONG_CALL_MS: Readonly<Record<string, number>> = Object.freeze(Object.fromEntries([
  ...Object.keys(WorkerMethods).filter(isLong).map((m) => [m, LONG_MS] as const),
  ['memory.consolidate', LONGEST_MS] as const,
]))

/** 页面能经 mffai:call 调的方法:WorkerMethods 自己的键,去掉 CALL_EXCLUDED */
export const isCallable = (m: unknown): m is WorkerMethodName =>
  typeof m === 'string' && Object.hasOwn(WorkerMethods, m) && !CALL_EXCLUDED.has(m)

/** 这个方法的参数 schema 里有 commandId(必填或可选)。故意没有的(setToken、settings.*、pairing.*)不补 */
export const takesCommandId = (m: WorkerMethodName): boolean =>
  Object.hasOwn((WorkerMethods[m].params as unknown as { shape: Record<string, unknown> }).shape, 'commandId')
