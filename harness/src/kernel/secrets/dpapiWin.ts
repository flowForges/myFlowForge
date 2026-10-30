import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { KeyUnreadableError, failure, type ExecResult } from './exec'
import { writePrivate } from './plainFile'
import type { MasterKeyBackend } from './secretStore'

type Run = (cmd: string, args: string[], stdin?: string) => Promise<ExecResult>

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '-']

/** 整段脚本与数据都经 stdin;输出 base64 */
/** 解不开(CryptographicException)→ 退出码 3;其余失败是一般错误 */
export const DPAPI_CANNOT_DECRYPT = 3

export function dpapiScript(op: 'Protect' | 'Unprotect', data: Buffer): string {
  return [
    'Add-Type -AssemblyName System.Security',
    `$b = [Convert]::FromBase64String('${data.toString('base64')}')`,
    `try { $r = [Security.Cryptography.ProtectedData]::${op}($b, $null, 'CurrentUser') } catch [System.Security.Cryptography.CryptographicException] { exit ${DPAPI_CANNOT_DECRYPT} }`,
    '[Console]::Out.Write([Convert]::ToBase64String($r))',
  ].join('; ') + '\n'
}

/** Windows:DPAPI(CurrentUser)保护主密钥,密文存 `master.dpapi` */
export function dpapiBackend(run: Run, file: string): MasterKeyBackend {
  const call = async (op: 'Protect' | 'Unprotect', data: Buffer): Promise<Buffer> => {
    const r = await run('powershell', PS_ARGS, dpapiScript(op, data))
    const out = r.stdout.trim()
    // 只有明确的"解不开"才算 unreadable;超时 / 起不来 / 其他非零都是暂时不可用
    if (op === 'Unprotect' && r.code === DPAPI_CANNOT_DECRYPT && !r.timedOut) throw new KeyUnreadableError('dpapi cannot decrypt')
    if (r.code !== 0 || !/^[A-Za-z0-9+/]+=*$/.test(out)) throw failure('powershell', r)
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
