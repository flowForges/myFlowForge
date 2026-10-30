import { randomBytes } from 'node:crypto'
import { failure, type ExecResult } from './exec'
import { PROBE_ACCOUNT, SERVICE, parseHexKey } from './keychainMac'
import type { MasterKeyBackend } from './secretStore'

type Run = (cmd: string, args: string[], stdin?: string) => Promise<ExecResult>

/** Linux:libsecret 的 `secret-tool`;store 的值走 stdin。lookup 非零 = 不存在(secret-tool 不区分) */
export function secretServiceBackend(run: Run, account: string): MasterKeyBackend {
  const attrs = (acct: string) => ['service', SERVICE, 'account', acct]
  const store = async (acct: string, value: string) => {
    const r = await run('secret-tool', ['store', '--label=myFlowForge', 'mff-ai', ...attrs(acct)], value)
    if (r.code !== 0) throw failure('secret-tool', r)
  }
  const lookup = async (acct: string): Promise<string | undefined> => {
    const r = await run('secret-tool', ['lookup', ...attrs(acct)])
    if (r.code === 1 && !r.timedOut && r.stdout === '') return undefined
    if (r.code !== 0) throw failure('secret-tool', r)
    return r.stdout.replace(/\r?\n$/, '')
  }
  return {
    name: 'secret-service',
    async probe() {
      try {
        const v = randomBytes(16).toString('hex')
        await store(PROBE_ACCOUNT, v)
        const back = await lookup(PROBE_ACCOUNT)
        await run('secret-tool', ['clear', ...attrs(PROBE_ACCOUNT)])
        return back === v
      } catch {
        return false
      }
    },
    async load() {
      const hex = await lookup(account)
      return hex === undefined ? undefined : parseHexKey(hex)
    },
    async save(key) {
      await store(account, key.toString('hex'))
    },
  }
}
