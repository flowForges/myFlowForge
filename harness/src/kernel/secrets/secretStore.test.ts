import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSecretStore, scopedSecrets } from './secretStore'
import type { Exec } from './exec'
import { fakeSecurity, type Call } from './fakeExec.test-util'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mffai-secrets-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const posix = process.platform !== 'win32'
const mode = (p: string) => statSync(p).mode & 0o777
/** argv 里绝不出现任何密钥 / 主密钥 */
const assertArgvClean = (calls: Call[], secrets: string[]) => {
  for (const c of calls) for (const s of secrets) expect(c.args.join(' ')).not.toContain(s)
}

describe('SecretStore on macOS keychain (injected exec)', () => {
  it('absent master key (44) → generate, save via stdin, round-trip values; argv never carries secrets', async () => {
    const sec = fakeSecurity()
    const s = await openSecretStore({ dataDir: dir, platform: 'darwin', exec: sec.exec })
    expect(s.backend).toBe('keychain')
    await s.set('a/key', 'sk-very-secret')
    expect(await s.get('a/key')).toBe('sk-very-secret')
    // 探测条目已删除,只剩主密钥一条
    expect([...sec.items.keys()]).toHaveLength(1)
    const master = [...sec.items.values()][0]
    expect(master).toMatch(/^[0-9a-f]{64}$/)
    expect(sec.calls.some(c => c.args[0] === 'find-generic-password')).toBe(true)
    expect(sec.calls.find(c => c.args[0] === '-i')!.stdin).toContain('-s myflowforge-mffai')
    assertArgvClean(sec.calls, ['sk-very-secret', master])
    for (const c of sec.calls) expect(c.timeoutMs).toBe(5000)
    // 文件里是密文
    const enc = readFileSync(join(dir, 'credentials.enc'), 'utf8')
    expect(enc).not.toContain('sk-very-secret')
    expect(Object.keys(JSON.parse(enc)).sort()).toEqual(['data', 'iv', 'tag', 'v'])
    if (posix) expect(mode(join(dir, 'credentials.enc'))).toBe(0o600)

    // 重开:读回同一主密钥,值仍在
    const again = await openSecretStore({ dataDir: dir, platform: 'darwin', exec: sec.exec })
    expect(again.backend).toBe('keychain')
    expect(await again.get('a/key')).toBe('sk-very-secret')
    await again.delete('a/key')
    expect(await again.get('a/key')).toBeUndefined()
  })

  it('account is sha8(dataDir); keychain path appended when configured', async () => {
    const sec = fakeSecurity()
    await openSecretStore({ dataDir: dir, platform: 'darwin', exec: sec.exec, macKeychainPath: '/tmp/x.keychain-db' })
    const finds = sec.calls.filter(c => c.args[0] === 'find-generic-password')
    for (const f of finds) expect(f.args.at(-1)).toBe('/tmp/x.keychain-db')
    expect(sec.calls.filter(c => c.args[0] === '-i').every(c => c.stdin.trimEnd().endsWith('"/tmp/x.keychain-db"'))).toBe(true)
    const accts = new Set(finds.map(f => f.args[f.args.indexOf('-a') + 1]))
    expect(accts.has('mffai-probe')).toBe(true)
    expect([...accts].some(a => /^[0-9a-f]{8}$/.test(a))).toBe(true)
  })

  it('security hangs on the master key (prompt / locked) → unavailable within the timeout, data kept', async () => {
    const sec = fakeSecurity({ hangOn: c => c.args[0] === 'find-generic-password' && !c.args.includes('mffai-probe') })
    writeFileSync(join(dir, 'credentials.enc'), '{"v":1,"iv":"","tag":"","data":""}')
    const t0 = Date.now()
    const s = await openSecretStore({ dataDir: dir, platform: 'darwin', exec: sec.exec, timeoutMs: 200 })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(s.backend).toBe('unavailable')
    expect(await s.get('x')).toBeUndefined()
    await expect(s.set('x', 'y')).rejects.toThrow('secrets unavailable')
    expect(readFileSync(join(dir, 'credentials.enc'), 'utf8')).toBe('{"v":1,"iv":"","tag":"","data":""}')
  })

  it('default timeout handed to exec is 5000 ms', async () => {
    const seen: number[] = []
    const exec: Exec = async (_c, _a, _s, t) => { seen.push(t); return { code: null, stdout: '', timedOut: true } }
    await openSecretStore({ dataDir: dir, platform: 'darwin', exec })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(t => t === 5000)).toBe(true)
  })

  it('probe times out while credentials.enc exists → unavailable (no silent plaintext switch)', async () => {
    const exec: Exec = async () => ({ code: null, stdout: '', timedOut: true })
    writeFileSync(join(dir, 'credentials.enc'), 'x')
    const s = await openSecretStore({ dataDir: dir, platform: 'darwin', exec })
    expect(s.backend).toBe('unavailable')
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false)
  })

  it('tampered credentials.enc → unreadable; never overwritten', async () => {
    const sec = fakeSecurity()
    const s = await openSecretStore({ dataDir: dir, platform: 'darwin', exec: sec.exec })
    await s.set('k', 'v')
    const file = join(dir, 'credentials.enc')
    const j = JSON.parse(readFileSync(file, 'utf8'))
    const data = Buffer.from(j.data, 'base64'); data[0] ^= 1
    const tampered = JSON.stringify({ ...j, data: data.toString('base64') })
    writeFileSync(file, tampered)
    const t = await openSecretStore({ dataDir: dir, platform: 'darwin', exec: sec.exec })
    expect(t.backend).toBe('unreadable')
    expect(await t.get('k')).toBeUndefined()
    await expect(t.set('k', 'w')).rejects.toThrow('secrets unreadable')
    await expect(t.delete('k')).rejects.toThrow('secrets unreadable')
    expect(readFileSync(file, 'utf8')).toBe(tampered)
  })

  it('master key gone from keychain but credentials.enc present → unreadable, file kept', async () => {
    const sec = fakeSecurity()
    const s = await openSecretStore({ dataDir: dir, platform: 'darwin', exec: sec.exec })
    await s.set('k', 'v')
    sec.items.clear()
    const before = readFileSync(join(dir, 'credentials.enc'), 'utf8')
    const t = await openSecretStore({ dataDir: dir, platform: 'darwin', exec: sec.exec })
    expect(t.backend).toBe('unreadable')
    expect(readFileSync(join(dir, 'credentials.enc'), 'utf8')).toBe(before)
  })
})

describe('plaintext-file fallback', () => {
  it('all probes fail → plaintext-file, 0600 file in 0700 dir', async () => {
    const sec = fakeSecurity({ failAll: true })
    const s = await openSecretStore({ dataDir: dir, platform: 'darwin', exec: sec.exec })
    expect(s.backend).toBe('plaintext-file')
    await s.set('p/k', 'v1')
    expect(await s.get('p/k')).toBe('v1')
    const file = join(dir, 'credentials.json')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'p/k': 'v1' })
    if (posix) {
      expect(mode(file)).toBe(0o600)
      expect(mode(dir)).toBe(0o700)
    }
  })

  it('loose modes are corrected on open', async () => {
    const file = join(dir, 'credentials.json')
    writeFileSync(file, '{"a":"b"}')
    if (posix) { chmodSync(file, 0o644); chmodSync(dir, 0o755) }
    const s = await openSecretStore({ dataDir: dir, platform: 'linux', exec: fakeSecurity({ failAll: true }).exec })
    expect(s.backend).toBe('plaintext-file')
    expect(await s.get('a')).toBe('b')
    if (posix) {
      expect(mode(file)).toBe(0o600)
      expect(mode(dir)).toBe(0o700)
    }
  })

  it('osBackend: false skips every external command', async () => {
    const sec = fakeSecurity()
    const s = await openSecretStore({ dataDir: dir, platform: 'darwin', exec: sec.exec, osBackend: false })
    expect(s.backend).toBe('plaintext-file')
    expect(sec.calls).toHaveLength(0)
  })

  it('plaintext data migrates into credentials.enc once an OS backend works', async () => {
    writeFileSync(join(dir, 'credentials.json'), '{"a":"b"}')
    const s = await openSecretStore({ dataDir: dir, platform: 'darwin', exec: fakeSecurity().exec })
    expect(s.backend).toBe('keychain')
    expect(await s.get('a')).toBe('b')
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false)
    expect(readFileSync(join(dir, 'credentials.enc'), 'utf8')).not.toContain('"b"')
  })
})

describe('scoped view', () => {
  it('prefixes keys with the plugin id; A cannot read B', async () => {
    const s = await openSecretStore({ dataDir: dir, osBackend: false })
    const a = scopedSecrets(s, 'plugin-a')
    const b = scopedSecrets(s, 'plugin-b')
    await b.set('token', 'b-secret')
    await a.set('token', 'a-secret')
    expect(await a.get('token')).toBe('a-secret')
    expect(await b.get('token')).toBe('b-secret')
    expect(await s.get('plugin-b/token')).toBe('b-secret')
    expect(await a.get('../plugin-b/token')).toBeUndefined()
    expect(await a.get('plugin-b/token')).toBeUndefined()
    await a.delete('token')
    expect(await b.get('token')).toBe('b-secret')
    expect(Object.keys(a).sort()).toEqual(['delete', 'get', 'set'])
  })
})
