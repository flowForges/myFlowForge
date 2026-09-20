import { describe, it, expect, vi } from 'vitest'
import { runPlugin, pluginEnv, type ExecRun } from './pluginHost'
import { EXTENSION_POINTS } from './extensionPoints'
import type { InstalledPlugin } from './pluginSchema'

const basePlugin: InstalledPlugin = {
  id: 'test-plugin',
  dir: '/fake/plugin',
  type: 'statusbar-usage',
  name: 'Test Plugin',
  entry: 'index.js',
  refreshSec: 300,
  enabled: true,
}

const validPayload = JSON.stringify({ window5h: { used: 10, limit: 100 } })

function makeExec(stdout: string, failed = false): ExecRun {
  return async () => ({ stdout, failed })
}

function throwingExec(): ExecRun {
  return async () => { throw new Error('exec exploded') }
}

describe('EXTENSION_POINTS statusbar-usage validate', () => {
  const ep = EXTENSION_POINTS['statusbar-usage']

  it('window5h only → ok', () => {
    const r = ep.validate({ window5h: { used: 5, limit: 50 } })
    expect(r.ok).toBe(true)
  })

  it('weekly only → ok', () => {
    const r = ep.validate({ weekly: { used: 100, limit: 1000 } })
    expect(r.ok).toBe(true)
  })

  it('neither window5h nor weekly → error', () => {
    const r = ep.validate({ label: 'only label' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBeTruthy()
  })

  it('both fields → ok', () => {
    const r = ep.validate({ window5h: { used: 1, limit: 10 }, weekly: { used: 5, limit: 50 } })
    expect(r.ok).toBe(true)
  })
})

describe('runPlugin', () => {
  it('valid statusbar-usage JSON → ok+type+data', async () => {
    const result = await runPlugin(basePlugin, { exec: makeExec(validPayload) })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.type).toBe('statusbar-usage')
      expect(result.data).toMatchObject({ window5h: { used: 10, limit: 100 } })
    }
  })

  it('non-JSON stdout → error', async () => {
    const result = await runPlugin(basePlugin, { exec: makeExec('not json at all') })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('JSON')
  })

  it('empty stdout → error', async () => {
    const result = await runPlugin(basePlugin, { exec: makeExec('') })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('无输出')
  })

  it('whitespace-only stdout → error', async () => {
    const result = await runPlugin(basePlugin, { exec: makeExec('   \n  ') })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('无输出')
  })

  it('failed:true → error', async () => {
    const result = await runPlugin(basePlugin, { exec: makeExec(validPayload, true) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('失败')
  })

  it('schema mismatch (no window field) → error', async () => {
    const bad = JSON.stringify({ label: 'no window' })
    const result = await runPlugin(basePlugin, { exec: makeExec(bad) })
    expect(result.ok).toBe(false)
  })

  it('unknown type → error with 不支持的类型', async () => {
    const plugin: InstalledPlugin = { ...basePlugin, type: 'unknown-type' }
    const result = await runPlugin(plugin, { exec: makeExec(validPayload) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('不支持的类型')
  })

  it('exec throws → error (caught, never throws)', async () => {
    const result = await runPlugin(basePlugin, { exec: throwingExec() })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('exec exploded')
  })

  it('valid payload with resetAt → ok', async () => {
    const payload = JSON.stringify({ window5h: { used: 5, limit: 50, resetAt: 1234567890 } })
    const result = await runPlugin(basePlugin, { exec: makeExec(payload) })
    expect(result.ok).toBe(true)
  })

  it('entry path traversal (../../bin/sh) → error, exec never called', async () => {
    const execSpy = vi.fn(async () => ({ stdout: '', failed: false }))
    const traversalPlugin: InstalledPlugin = { ...basePlugin, entry: '../../bin/sh' }
    const result = await runPlugin(traversalPlugin, { exec: execSpy })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('越界')
    expect(execSpy).not.toHaveBeenCalled()
  })
})

describe('pluginEnv — the allowlist handed to untrusted plugin subprocesses', () => {
  it('never forwards secrets from the parent environment', () => {
    const env = pluginEnv({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-secret', OPENAI_API_KEY: 'x' }, 'darwin')
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(env).not.toHaveProperty('OPENAI_API_KEY')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('POSIX: carries HOME and TMPDIR', () => {
    const env = pluginEnv({ PATH: '/usr/bin', HOME: '/Users/me', TMPDIR: '/var/t' }, 'darwin')
    expect(env.HOME).toBe('/Users/me')
    expect(env.TMPDIR).toBe('/var/t')
  })

  // A Windows process started without SystemRoot cannot initialise Winsock — every network call in
  // the plugin fails with an unrelated-looking error. This is the classic minimal-env trap.
  it('Windows: carries SystemRoot, or the plugin cannot use the network at all', () => {
    const env = pluginEnv({ PATH: 'C:\\bin', SystemRoot: 'C:\\Windows' }, 'win32')
    expect(env.SystemRoot).toBe('C:\\Windows')
  })

  it('Windows: carries PATHEXT so a .cmd/.bat entry can be resolved', () => {
    const env = pluginEnv({ PATH: 'C:\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32')
    expect(env.PATHEXT).toBe('.COM;.EXE;.BAT;.CMD')
  })

  it('Windows: USERPROFILE stands in for HOME, which Windows does not set', () => {
    const env = pluginEnv({ PATH: 'C:\\bin', USERPROFILE: 'C:\\Users\\me' }, 'win32')
    expect(env.USERPROFILE).toBe('C:\\Users\\me')
    expect(env.HOME).toBe('C:\\Users\\me')
  })

  it('Windows: TEMP/TMP stand in for TMPDIR', () => {
    const env = pluginEnv({ PATH: 'C:\\bin', TEMP: 'C:\\T', TMP: 'C:\\T' }, 'win32')
    expect(env.TEMP).toBe('C:\\T')
    expect(env.TMP).toBe('C:\\T')
  })

  it('omits variables the parent does not have, rather than setting them empty', () => {
    expect(pluginEnv({ PATH: '/usr/bin' }, 'darwin')).not.toHaveProperty('HOME')
  })
})
