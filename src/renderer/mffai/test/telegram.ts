// Telegram 子页的夹具(Task 10):Telegram.test.tsx 和 noHintRender.test.tsx 共用
import type { TelegramStatus } from '@mffai/protocol'
import type { CallTable } from './fakeForge'
import { perms } from './sessions'

export const tgStatus = (o: Partial<TelegramStatus> = {}): TelegramStatus => ({
  state: 'online', enabled: true, tokenSet: true, bot: { id: 1, username: 'my_test_bot' }, secretsBackend: 'keychain',
  proxy: 'none', lastOkAt: Date.now() - 5_000, paired: [], pairing: { active: false },
  dropped: { unpaired: 1, stale: 2, group: 3, attachment: 4, badUpdate: 5 }, undelivered: 0, problems: [], ...o,
})

/** config.get 带一个这页不认识的键:保存要原样带回去 */
export const tgConfig = () => ({ enabled: true, staleMinutes: 10, later: 'keep', projects: [{ name: 'api', path: '/w/api', auto: false }] })

export function tgCalls(status: TelegramStatus = tgStatus()): CallTable {
  return {
    'channel.telegram.status': status,
    'channel.telegram.config.get': tgConfig() as never,
    'channel.telegram.config.set': { ok: true },
    'channel.telegram.chats': { chats: [], worktrees: [] },
    'permissions.get': perms('full'),
  }
}
