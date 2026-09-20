import { describe, it, expect, vi } from 'vitest'
import { parseAppPathValue, queryAppPath } from './winRegistry'

// Real `reg.exe query "…\App Paths\Code.exe" /ve` output, verbatim shape (blank first line included).
const REAL = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe
    (Default)    REG_SZ    C:\\Program Files\\Microsoft VS Code\\Code.exe

`

describe('parseAppPathValue', () => {
  it('extracts the default value from reg.exe output', () => {
    expect(parseAppPathValue(REAL)).toBe('C:\\Program Files\\Microsoft VS Code\\Code.exe')
  })
  it('keeps spaces inside the path (the value is everything after REG_SZ)', () => {
    const out = '    (Default)    REG_SZ    C:\\Program Files (x86)\\JetBrains\\IntelliJ IDEA\\bin\\idea64.exe'
    expect(parseAppPathValue(out)).toBe('C:\\Program Files (x86)\\JetBrains\\IntelliJ IDEA\\bin\\idea64.exe')
  })
  it('strips the quotes some installers write around the value', () => {
    expect(parseAppPathValue('    (Default)    REG_SZ    "C:\\Apps\\x.exe"')).toBe('C:\\Apps\\x.exe')
  })
  it('returns null for "ERROR: The system was unable to find the specified registry key"', () => {
    expect(parseAppPathValue('ERROR: The system was unable to find the specified registry key or value.')).toBeNull()
  })
  it('returns null for an empty / whitespace-only value', () => {
    expect(parseAppPathValue('    (Default)    REG_SZ    ')).toBeNull()
    expect(parseAppPathValue('')).toBeNull()
  })
  it('ignores REG_EXPAND_SZ-only noise it cannot interpret', () => {
    expect(parseAppPathValue('    Path    REG_SZ    C:\\Program Files\\Microsoft VS Code')).toBe('C:\\Program Files\\Microsoft VS Code')
  })
})

describe('queryAppPath', () => {
  const HKCU = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe'
  const HKLM = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe'

  it('queries the per-user hive first (that is where user-scope installers write)', async () => {
    const seen: string[] = []
    const reg = vi.fn(async (key: string) => { seen.push(key); return key.startsWith('HKCU') ? REAL : '' })
    expect(await queryAppPath('Code.exe', reg, () => true)).toBe('C:\\Program Files\\Microsoft VS Code\\Code.exe')
    expect(seen[0]).toBe(HKCU)
  })

  it('falls back to the machine hive when the user hive has no entry', async () => {
    const seen: string[] = []
    const reg = vi.fn(async (key: string) => { seen.push(key); return key.startsWith('HKLM') ? REAL : '' })
    expect(await queryAppPath('Code.exe', reg, () => true)).toBe('C:\\Program Files\\Microsoft VS Code\\Code.exe')
    expect(seen).toEqual([HKCU, HKLM])
  })

  it('rejects a registry entry pointing at a path that no longer exists (stale uninstall)', async () => {
    const reg = async () => REAL
    expect(await queryAppPath('Code.exe', reg, () => false)).toBeNull()
  })

  it('returns null (never throws) when reg.exe itself fails — it does not exist off Windows', async () => {
    const reg = async () => { throw new Error('spawn reg ENOENT') }
    expect(await queryAppPath('Code.exe', reg, () => true)).toBeNull()
  })
})
