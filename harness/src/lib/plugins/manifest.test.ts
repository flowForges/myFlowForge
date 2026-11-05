import { describe, it, expect } from 'vitest'
import { parseNative, satisfiesKernel } from './manifest'
import { deriveId, parseClaudeManifest, unwrapServers } from './claudeFormat'

const base = { id: 'web-tools', version: '1.2.0' }

describe('satisfiesKernel', () => {
  const rows: [string, string, boolean][] = [
    ['0.1.0', '0.1.0', true], ['0.1.0', '0.1.1', false], ['^0.1.0', '0.1.5', true], ['^0.1.2', '0.1.1', false],
    ['^0.1.0', '0.2.0', false], ['^1.2.0', '1.9.0', true], ['^1.2.0', '2.0.0', false], ['^1.2.0', '1.1.9', false],
    ['^0.0.3', '0.0.3', true], ['^0.0.3', '0.0.4', false], ['~1.2.0', '1.2.9', true], ['~1.2.0', '1.3.0', false],
    ['>=0.1.0', '0.1.0', false], ['*', '0.1.0', false], ['1.x', '1.0.0', false], ['^0.1.0 || ^1', '0.1.0', false],
    ['v0.1.0', '0.1.0', false], ['^0.1.0-beta', '0.1.0', false], ['^0.1.0', '0.1.0-beta', false], ['', '0.1.0', false], ['^0.1.0', 'x', false],
  ]
  it.each(rows)('%s vs %s', (r, v, ok) => expect(satisfiesKernel(r, v)).toBe(ok))
})

describe('parseNative', () => {
  it('accepts the spec example shape', () => {
    const r = parseNative({
      ...base, kernel: '^0.1.0', name: 'Web', skills: './skills', commands: ['./commands'], main: './dist/plugin.mjs',
      mcpServers: { search: { command: 'node', args: ['${MFF_PLUGIN_ROOT}/s.js'], env: { K: '${user_config.k}' }, permissions: { network: ['api.example.com'], cwd: 'read' } } },
      userConfig: { k: { title: 'Key', sensitive: true, required: true } },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest.skills).toEqual(['./skills'])
      expect(r.manifest.userConfig.get('k')?.sensitive).toBe(true)
    }
  })

  it('rejects unknown keys, bad ids and versions', () => {
    expect(parseNative({ ...base, surprise: 1 }).ok).toBe(false)
    expect(parseNative({ id: 'Bad_Id', version: '1.0.0' }).ok).toBe(false)
    expect(parseNative({ id: 'x', version: 'one' }).ok).toBe(false)
    expect(parseNative(null).ok).toBe(false)
    expect(parseNative([]).ok).toBe(false)
  })

  const server = (permissions: unknown) => ({ ...base, mcpServers: { s: { command: 'node', permissions } } })
  it.each([
    ['filesystem', { filesystem: ['/'] }],
    ['wildcard', { network: ['*'] }],
    ['wildcard host', { network: ['*.example.com'] }],
    ['path', { network: ['example.com/x'] }],
    ['port', { network: ['example.com:443'] }],
    ['bare ip', { network: ['10.0.0.1'] }],
    ['localhost', { network: ['localhost'] }],
    ['internal', { network: ['db.internal'] }],
    ['cwd root', { cwd: 'root' }],
  ])('rejects permissions: %s', (_n, p) => expect(parseNative(server(p)).ok).toBe(false))

  it('accepts a narrow request and an unknown server key is rejected', () => {
    expect(parseNative(server({ network: ['api.example.com'], cwd: 'none' })).ok).toBe(true)
    expect(parseNative({ ...base, mcpServers: { s: { command: 'node', url: 'https://x.example.com' } } }).ok).toBe(false)
  })

  it('__proto__ as a server name stays a Map entry', () => {
    const r = parseNative({ ...base, mcpServers: JSON.parse('{"__proto__":{"command":"node"},"constructor":{"command":"node"}}') })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const d = r.manifest.mcp[0]
      expect(d.kind === 'inline' && [...d.servers.keys()].sort()).toEqual(['__proto__', 'constructor'])
    }
    expect(({} as Record<string, unknown>).command).toBeUndefined()
  })

  it('error text is one clean short line', () => {
    const r = parseNative({ ...base, ['evil‮\nkey']: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).not.toMatch(/[\n‮]/)
      expect(r.error.length).toBeLessThanOrEqual(200)
    }
  })
})

describe('parseClaudeManifest', () => {
  it('ignores unknown keys and bad types', () => {
    const r = parseClaudeManifest({ name: 'x', version: 3, foo: 1, skills: ['./a', 5], author: { name: 'Me' }, userConfig: { k: { sensitive: true }, '__proto__': {}, bad: 1 } })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest.version).toBeUndefined()
      expect(r.manifest.skills).toEqual(['./a'])
      expect(r.manifest.author).toBe('Me')
      expect([...r.manifest.userConfig.keys()]).toEqual(['k'])
    }
  })

  it('commands: array, object map, none', () => {
    const arr = parseClaudeManifest({ commands: ['./c.md'] })
    const map = parseClaudeManifest({ commands: { a: { source: './a.md' }, b: { content: 'hi' } } })
    const none = parseClaudeManifest({})
    expect(arr.ok && arr.manifest.commands?.paths).toEqual(['./c.md'])
    expect(map.ok && [...(map.manifest.commands?.map.keys() ?? [])]).toEqual(['a', 'b'])
    expect(none.ok && none.manifest.commands).toBeUndefined()
  })

  it('unwrapServers handles both shapes', () => {
    expect([...unwrapServers({ mcpServers: { a: { command: 'x' } } }).keys()]).toEqual(['a'])
    expect([...unwrapServers({ a: { command: 'x' }, b: { url: 'u' } }).keys()]).toEqual(['a', 'b'])
    expect(unwrapServers('x').size).toBe(0)
  })

  it('deriveId', () => {
    expect(deriveId('Claude HUD')).toBe('claude-hud')
    expect(deriveId('@scope/Thing_1')).toBe('scope-thing-1')
    expect(deriveId('!!!')).toBeNull()
    expect(deriveId('a'.repeat(100))?.length).toBe(64)
  })
})
