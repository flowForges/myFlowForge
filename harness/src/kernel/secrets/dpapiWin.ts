import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { KeyUnreadableError, failure, type ExecResult } from './exec'
import { writePrivate } from './plainFile'
import type { MasterKeyBackend } from './secretStore'

type Run = (cmd: string, args: string[], stdin?: string) => Promise<ExecResult>

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '-']

/** 整段脚本与数据都经 stdin;输出 base64 */
export function dpapiScript(op: 'Protect' | 'Unprotect', data: Buffer): string {
  return [
    'Add-Type -AssemblyName System.Security',
    `$b = [Convert]::FromBase64String('${data.toString('base64')}')`,
    `$r = [Security.Cryptography.ProtectedData]::${op}($b, $null, 'CurrentUser')`,
    '[Console]::Out.Write([Convert]::ToBase64String($r))',
  ].join('; ') + '\n'
}

/** Windows:DPAPI(CurrentUser)保护主密钥,密文存 `master.dpapi` */
export function dpapiBackend(run: Run, file: string): MasterKeyBackend {
  const call = async (op: 'Protect' | 'Unprotect', data: Buffer): Promise<Buffer> => {
    const r = await run('powershell', PS_ARGS, dpapiScript(op, data))
    const out = r.stdout.trim()
    if (r.timedOut || r.code === null) throw failure('powershell', r)
    // 脚本跑了却失败:Unprotect 时即"解不开"
    if (r.code !== 0 || !/^[A-Za-z0-9+/]+=*$/.test(out)) throw op === 'Unprotect' ? new KeyUnreadableError('dpapi unprotect failed') : failure('powershell', r)
    return Buffer.from(out, 'base64')
  }
  return {
    name: 'dpapi',
    async probe() {
      try {
        const v = randomBytes(16)
        return (await call('Unprotect', await call('Protect', v))).equals(v)
      } catch {
        return false
      }
    },
    async load() {
      if (!existsSync(file)) return undefined
      const key = await call('Unprotect', Buffer.from(readFileSync(file, 'utf8').trim(), 'base64'))
      if (key.length !== 32) throw new KeyUnreadableError('master key malformed')
      return key
    },
    async save(key) {
      writePrivate(file, (await call('Protect', key)).toString('base64'))
    },
  }
}
