import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// codex 传输的默认值改成 app-server(插话只在它上面有)。没自己选过的用户 —— 包括磁盘上躺着一份
// 老默认 'exec' 的(writeSettings 每次都把全部 host 键落盘,所以「有值」不等于「选过」)—— 得到新默认;
// 在设置里亲手选过 exec 的保持 exec。
vi.mock('./paths', async (orig) => {
  const actual = await orig<typeof import('./paths')>()
  return { ...actual, SYS_DIR: '__REPLACED__', sysFile: (n: string) => join((globalThis as any).__SYS__, n) }
})
const { readSettings, writeSettings } = await import('./store')
const { defaultSettings, HostSettingsSchema } = await import('./schema')

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'forge-cxt-')); (globalThis as any).__SYS__ = tmp })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))
const host = (o: unknown) => writeFileSync(join(tmp, 'settings.json'), JSON.stringify(o))

describe('codexTransport 默认值', () => {
  it('新装:默认 app-server', () => {
    expect(defaultSettings().codexTransport).toBe('app-server')
    expect(HostSettingsSchema.shape.codexTransport.parse(undefined)).toBe('app-server')
    expect(readSettings().codexTransport).toBe('app-server')
  })

  it('老用户磁盘上是老默认 exec、从没亲手选过 → 新默认 app-server', () => {
    host({ codexTransport: 'exec', agentProxy: '' })
    expect(readSettings().codexTransport).toBe('app-server')
  })

  it('亲手选过 exec → 保持 exec,写回去也还是 exec', () => {
    host({ codexTransport: 'exec', codexTransportChosen: true })
    expect(readSettings().codexTransport).toBe('exec')
    writeSettings(readSettings())
    expect(readSettings().codexTransport).toBe('exec')
    expect(JSON.parse(readFileSync(join(tmp, 'settings.json'), 'utf8')).codexTransportChosen).toBe(true)
  })

  it('坏值 → app-server', () => {
    host({ codexTransport: 'bogus', codexTransportChosen: true })
    expect(readSettings().codexTransport).toBe('app-server')
  })
  it('★升级前就打开过 app-server(老默认是 exec,所以只能是亲手拨的)、没有标记 → 算选过,工作流也走 app-server', () => {
    host({ codexTransport: 'app-server' })
    const s = readSettings()
    expect(s.codexTransport).toBe('app-server')
    expect(s.codexTransportChosen).toBe(true)
  })

  it('坏值被 .catch 兜成默认时,「选过」也一并清掉', () => {
    host({ codexTransport: 'bogus', codexTransportChosen: true })
    expect(readSettings().codexTransportChosen).toBe(false)
  })
})
