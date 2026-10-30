import { randomBytes } from 'node:crypto'
import type { Logger } from '../log'
import { KeyUnreadableError, failure, type ExecResult } from './exec'
import type { MasterKeyBackend } from './secretStore'

type Run = (cmd: string, args: string[], stdin?: string) => Promise<ExecResult>

export const SERVICE = 'myflowforge-mffai'
export const PROBE_ACCOUNT = 'mffai-probe'

/** `security -i` 一行一条命令:换行会注入第二条命令,直接拒绝 */
export function securityQuote(s: string): string {
  if (/[\r\n]/.test(s)) throw new Error('security argument contains a line break')
  return `"${s.replace(/[\\"]/g, c => `\\${c}`)}"`
}

/** macOS:`security`;写入走 `security -i` 的 stdin,值不进 argv。find 退出码 44 = 不存在 */
export function keychainBackend(run: Run, account: string, log: Logger, keychainPath?: string): MasterKeyBackend {
  const kc = keychainPath ? [keychainPath] : []
  const add = async (acct: string, value: string) => {
    const line = `add-generic-password -a ${acct} -s ${SERVICE} -U -w ${securityQuote(value)}${keychainPath ? ` ${securityQuote(keychainPath)}` : ''}\n`
    const r = await run('security', ['-i'], line)
    if (r.code !== 0) throw failure('security', r)
  }
  const find = async (acct: string): Promise<string | undefined> => {
    const r = await run('security', ['find-generic-password', '-a', acct, '-s', SERVICE, '-w', ...kc])
    if (r.code === 44 && !r.timedOut) return undefined
    if (r.code !== 0) throw failure('security', r)
    return r.stdout.replace(/\r?\n$/, '')
  }
  const del = async (acct: string) => {
    const r = await run('security', ['delete-generic-password', '-a', acct, '-s', SERVICE, ...kc])
    if (r.code !== 0 && r.code !== 44) throw failure('security', r)
  }
  return {
    name: 'keychain',
    async probe() {
      try {
        const v = randomBytes(16).toString('hex')
        await add(PROBE_ACCOUNT, v)
        const back = await find(PROBE_ACCOUNT)
        await del(PROBE_ACCOUNT).catch(err => log.warn('secrets probe cleanup failed', { backend: 'keychain', failure: (err as Error).message }))
        return back === v
      } catch {
        return false
      }
    },
    async load() {
      const hex = await find(account)
      return hex === undefined ? undefined : parseHexKey(hex)
    },
    async save(key) {
      await add(account, key.toString('hex'))
      // `security -i` 的退出码不一定反映内部命令:读回确认
      const back = await find(account)
      if (back !== key.toString('hex')) throw new Error('security save not confirmed')
    },
  }
}

export function parseHexKey(hex: string): Buffer {
  const t = hex.trim()
  if (!/^[0-9a-f]{64}$/i.test(t)) throw new KeyUnreadableError('master key malformed')
  return Buffer.from(t, 'hex')
}
