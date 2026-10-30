import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exec } from './exec'
import { openSecretStore } from './secretStore'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mffai-secrets-b-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

type Call = { cmd: string; args: string[]; stdin: string }

/** 假 PowerShell:Protect = 加前缀 "P:",Unprotect = 去前缀;只认我们的脚本形状 */
function fakePowershell() {
  const calls: Call[] = []
  const exec: Exec = async (cmd, args, stdin) => {
    calls.push({ cmd, args, stdin })
    const m = /FromBase64String\('([A-Za-z0-9+/=]*)'\)/.exec(stdin)
    if (cmd !== 'powershell' || !m) return { code: 1, stdout: '', timedOut: false }
    const input = Buffer.from(m[1], 'base64')
    if (stdin.includes('ProtectedData]::Protect(')) {
      return { code: 0, stdout: Buffer.concat([Buffer.from('P:'), input]).toString('base64') + '\r\n', timedOut: false }
    }
    if (stdin.includes('ProtectedData]::Unprotect(')) {
      if (input.subarray(0, 2).toString() !== 'P:') return { code: 1, stdout: '', timedOut: false }
      return { code: 0, stdout: input.subarray(2).toString('base64') + '\r\n', timedOut: false }
    }
    return { code: 1, stdout: '', timedOut: false }
  }
  return { exec, calls }
}

/** 假 secret-tool:store 值走 stdin */
function fakeSecretTool() {
  const items = new Map<string, string>()
  const calls: Call[] = []
  const exec: Exec = async (cmd, args, stdin) => {
    calls.push({ cmd, args, stdin })
    if (cmd !== 'secret-tool') return { code: null, stdout: '', timedOut: false }
    const acct = args[args.indexOf('account') + 1]
    if (args[0] === 'store') { items.set(acct, stdin); return { code: 0, stdout: '', timedOut: false } }
    if (args[0] === 'lookup') {
      const v = items.get(acct)
      return v === undefined ? { code: 1, stdout: '', timedOut: false } : { code: 0, stdout: v, timedOut: false }
    }
    if (args[0] === 'clear') { items.delete(acct); return { code: 0, stdout: '', timedOut: false } }
    return { code: 1, stdout: '', timedOut: false }
  }
  return { exec, calls, items }
}

describe('Windows DPAPI backend (injected exec)', () => {
  it('protects the master key via PowerShell stdin; argv carries no data', async () => {
    const ps = fakePowershell()
    const s = await openSecretStore({ dataDir: dir, platform: 'win32', exec: ps.exec })
    expect(s.backend).toBe('dpapi')
    await s.set('k', 'sk-win-secret')
    const protectedKey = readFileSync(join(dir, 'master.dpapi'), 'utf8').trim()
    const master = Buffer.from(protectedKey, 'base64').subarray(2)
    expect(master).toHaveLength(32)
    for (const c of ps.calls) {
      expect(c.cmd).toBe('powershell')
      expect(c.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', '-'])
      expect(c.stdin).toContain('Add-Type -AssemblyName System.Security')
      expect(c.stdin).toContain("'CurrentUser'")
      expect(c.args.join(' ')).not.toContain(master.toString('base64'))
    }
    const again = await openSecretStore({ dataDir: dir, platform: 'win32', exec: ps.exec })
    expect(again.backend).toBe('dpapi')
    expect(await again.get('k')).toBe('sk-win-secret')
  })

  it('Unprotect fails (other user / machine) → unreadable', async () => {
    const ps = fakePowershell()
    const s = await openSecretStore({ dataDir: dir, platform: 'win32', exec: ps.exec })
    await s.set('k', 'v')
    // 探测仍能往返(Protect+Unprotect 自身数据),只有 master.dpapi 解不开
    const masterB64 = readFileSync(join(dir, 'master.dpapi'), 'utf8').trim()
    const failing: Exec = async (cmd, args, stdin, t) =>
      stdin.includes(masterB64) ? { code: 1, stdout: '', timedOut: false } : ps.exec(cmd, args, stdin, t)
    const t = await openSecretStore({ dataDir: dir, platform: 'win32', exec: failing })
    expect(t.backend).toBe('unreadable')
    expect(existsSync(join(dir, 'credentials.enc'))).toBe(true)
  })

  it('powershell missing → plaintext-file', async () => {
    const exec: Exec = async () => ({ code: null, stdout: '', timedOut: false })
    const s = await openSecretStore({ dataDir: dir, platform: 'win32', exec })
    expect(s.backend).toBe('plaintext-file')
  })
})

describe('Linux secret-service backend (injected exec)', () => {
  it('stores the master key with secret-tool, value on stdin only', async () => {
    const st = fakeSecretTool()
    const s = await openSecretStore({ dataDir: dir, platform: 'linux', exec: st.exec })
    expect(s.backend).toBe('secret-service')
    await s.set('k', 'sk-linux-secret')
    expect([...st.items.keys()]).toHaveLength(1)
    const [acct, master] = [...st.items.entries()][0]
    expect(acct).toMatch(/^[0-9a-f]{8}$/)
    expect(master).toMatch(/^[0-9a-f]{64}$/)
    const store = st.calls.find(c => c.args[0] === 'store' && c.args.includes(acct))!
    expect(store.args).toEqual(['store', '--label=myFlowForge', 'mff-ai', 'service', 'myflowforge-mffai', 'account', acct])
    expect(st.calls.find(c => c.args[0] === 'lookup')!.args).toEqual(['lookup', 'service', 'myflowforge-mffai', 'account', 'mffai-probe'])
    expect(st.calls.some(c => c.args[0] === 'clear' && c.args.includes('mffai-probe'))).toBe(true)
    for (const c of st.calls) expect(c.args.join(' ')).not.toContain(master)
    const again = await openSecretStore({ dataDir: dir, platform: 'linux', exec: st.exec })
    expect(await again.get('k')).toBe('sk-linux-secret')
  })

  it('no D-Bus (secret-tool non-zero) → plaintext-file', async () => {
    const exec: Exec = async () => ({ code: 1, stdout: '', timedOut: false })
    const s = await openSecretStore({ dataDir: dir, platform: 'linux', exec })
    expect(s.backend).toBe('plaintext-file')
  })
})
