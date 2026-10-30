import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSecretStore } from './secretStore'

// 真 `security` 集成测试:仅 MFFAI_KEYCHAIN_IT=1 且 macOS;只用临时钥匙串文件,绝不碰登录钥匙串
const IT = process.env.MFFAI_KEYCHAIN_IT === '1' && process.platform === 'darwin'

describe.skipIf(!IT)('macOS keychain integration (temp keychain)', () => {
  let tmp: string
  let kc: string
  let data: string
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mffai-kc-'))
    kc = join(tmp, 't.keychain-db')
    data = join(tmp, 'data')
    execFileSync('security', ['create-keychain', '-p', 'x', kc])
    execFileSync('security', ['unlock-keychain', '-p', 'x', kc])
  })
  afterAll(() => {
    try { execFileSync('security', ['delete-keychain', kc]) } catch { /* 已删 */ }
    rmSync(tmp, { recursive: true, force: true })
  })

  it('probe, generate master key, reopen and decrypt', async () => {
    const s = await openSecretStore({ dataDir: data, platform: 'darwin', macKeychainPath: kc })
    expect(s.backend).toBe('keychain')
    await s.set('a/k', 'v "quoted" \\ back')
    const again = await openSecretStore({ dataDir: data, platform: 'darwin', macKeychainPath: kc })
    expect(again.backend).toBe('keychain')
    expect(await again.get('a/k')).toBe('v "quoted" \\ back')
  })
})
