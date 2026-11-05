import { describe, it, expect } from 'vitest'
import { buildConsent, consentHash, diffConsent, effectiveGrants, intersectOnUpgrade, type Declared } from './consent'
import type { ParsedPlugin, ParsedServer, ParsedSkill, ParsedCommand } from './types'
import type { PluginConsent } from '../../protocol'

const skill = (name: string, extra: Partial<ParsedSkill> = {}): ParsedSkill => ({
  name, dir: name, file: `${name}/SKILL.md`, description: `does ${name}`, modelInvocable: true, userInvocable: true,
  argNames: [], files: 1, flags: [], ignored: [], hiddenChars: false, tooLarge: false, bodyHash: `h-${name}`, ...extra,
})
const command = (name: string, extra: Partial<ParsedCommand> = {}): ParsedCommand => ({
  name, file: `commands/${name}.md`, description: `cmd ${name}`, argNames: [], flags: [], ignored: [], hiddenChars: false, tooLarge: false, body: 'b', bodyHash: `c-${name}`, ...extra,
})
const server = (name: string, extra: Partial<ParsedServer> = {}): ParsedServer => ({
  name, command: 'node', args: ['${PLUGIN_ROOT}/srv.js', '--data', '${PLUGIN_DATA}', '--cwd', '${PROJECT_DIR}'],
  env: [{ name: 'MODE', source: 'literal', required: false, value: 'fast' }], fetchesAtRuntime: false,
  declared: { network: ['api.example.com'], cwd: 'read' }, suggestedHosts: [], problems: [], configRefs: [], ...extra,
})
const plugin = (extra: Partial<ParsedPlugin> = {}): ParsedPlugin => ({
  id: 'demo', version: '1.0.0', format: 'native', claimed: { name: 'Demo', description: 'A demo', author: 'me', homepage: 'https://demo.example' },
  skills: [skill('a'), skill('b')], commands: [command('go')], servers: [server('s1')],
  config: [{ key: 'TOKEN', title: 'Token', sensitive: true, required: true, type: 'string', from: 'manifest' }],
  notRun: { hooks: [{ event: 'SessionStart', command: 'echo hi' }], agents: ['ag'], bin: [], monitors: [], workflows: [], lsp: [], other: [], remoteMcp: [], scripts: [] },
  warnings: [], ...extra,
})
const SRC = { kind: 'git' as const, url: 'https://github.com/x/y', commit: 'abc' }
const S = { source: SRC, integrity: 'sha256-AAA', files: 10, bytes: 1000 }
const build = (p = plugin(), s = S) => buildConsent(p, s)
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))

describe('consentHash', () => {
  it('is stable under key order and list order from the reader', () => {
    const c = build()
    const reordered = JSON.parse(JSON.stringify(c, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v)))
    expect(consentHash(reordered)).toBe(consentHash(c))
    const shuffled = build(plugin({ skills: [skill('b'), skill('a')] }))
    expect(consentHash(shuffled)).toBe(consentHash(c))
    expect(consentHash(c)).toMatch(/^[0-9a-f]{64}$/)
  })

  const mutations: [string, (c: PluginConsent) => void][] = [
    ['id', c => { c.id = 'other' }],
    ['version', c => { c.version = '2' }],
    ['format', c => { c.format = 'claude' }],
    ['claimed.name', c => { c.claimed.name = 'x' }],
    ['claimed.description', c => { c.claimed.description = 'x' }],
    ['claimed.author', c => { c.claimed.author = 'x' }],
    ['claimed.homepage', c => { c.claimed.homepage = 'x' }],
    ['source.url', c => { if (c.source.kind === 'git') c.source.url = 'https://x' }],
    ['source.commit', c => { if (c.source.kind === 'git') c.source.commit = 'def' }],
    ['integrity', c => { c.integrity = 'sha256-BBB' }],
    ['files', c => { c.files++ }],
    ['bytes', c => { c.bytes++ }],
    ['skill name', c => { c.skills[0]!.name = 'z' }],
    ['skill description', c => { c.skills[0]!.description = 'z' }],
    ['skill modelInvocable', c => { c.skills[0]!.modelInvocable = false }],
    ['skill userInvocable', c => { c.skills[0]!.userInvocable = false }],
    ['skill files', c => { c.skills[0]!.files++ }],
    ['skill flags', c => { c.skills[0]!.flags.push('exec') }],
    ['skill ignored', c => { c.skills[0]!.ignored.push('x') }],
    ['command name', c => { c.commands[0]!.name = 'z' }],
    ['command description', c => { c.commands[0]!.description = 'z' }],
    ['command flags', c => { c.commands[0]!.flags.push('exec') }],
    ['command ignored', c => { c.commands[0]!.ignored.push('x') }],
    ['mcp name', c => { c.mcp[0]!.name = 'z' }],
    ['mcp command', c => { c.mcp[0]!.command = 'deno' }],
    ['mcp arg', c => { c.mcp[0]!.args[1] = '--other' }],
    ['mcp args extra', c => { c.mcp[0]!.args.push('x') }],
    ['mcp fetchesAtRuntime', c => { c.mcp[0]!.fetchesAtRuntime = true }],
    ['mcp env name', c => { c.mcp[0]!.env[0]!.name = 'MODE2' }],
    ['mcp env source', c => { c.mcp[0]!.env[0]!.source = 'secret' }],
    ['mcp env required', c => { c.mcp[0]!.env[0]!.required = true }],
    ['mcp env value', c => { c.mcp[0]!.env[0]!.value = 'slow' }],
    ['mcp declared network', c => { c.mcp[0]!.declared = { network: ['x.example.com'], cwd: 'read' } }],
    ['mcp declared cwd', c => { c.mcp[0]!.declared = { network: ['api.example.com'], cwd: 'write' } }],
    ['mcp declared null', c => { c.mcp[0]!.declared = null }],
    ['mcp suggestedHosts', c => { c.mcp[0]!.suggestedHosts.push('pypi.org') }],
    ['mcp problems', c => { c.mcp[0]!.problems.push('bad_command') }],
    ['config key', c => { c.config[0]!.key = 'K2' }],
    ['config title', c => { c.config[0]!.title = 'T2' }],
    ['config sensitive', c => { c.config[0]!.sensitive = false }],
    ['config required', c => { c.config[0]!.required = false }],
    ['config type', c => { c.config[0]!.type = 'number' }],
    ['hook command', c => { c.notRun.hooks[0]!.command = 'echo bye' }],
    ['hook event', c => { c.notRun.hooks[0]!.event = 'Stop' }],
    ['hook added', c => { c.notRun.hooks.push({ event: 'Stop', command: 'x' }) }],
    ['notRun agents', c => { c.notRun.agents.push('x') }],
    ['notRun bin', c => { c.notRun.bin.push('x') }],
    ['notRun monitors', c => { c.notRun.monitors.push('x') }],
    ['notRun workflows', c => { c.notRun.workflows.push('x') }],
    ['notRun lsp', c => { c.notRun.lsp.push('x') }],
    ['notRun other', c => { c.notRun.other.push('x') }],
    ['notRun remoteMcp', c => { c.notRun.remoteMcp.push({ name: 'r', type: 'http', url: 'https://r' }) }],
    ['notRun main', c => { c.notRun.main = './m.mjs' }],
    ['notRun scripts', c => { c.notRun.scripts.push('x') }],
    ['warnings', c => { c.warnings.push('shell_in_text') }],
    ['diff', c => { c.diff = diffConsent(c, c, { from: new Map(), to: new Map() }) }],
  ]
  it.each(mutations)('changes when %s changes', (_n, mutate) => {
    const base = build()
    const c = clone(base)
    mutate(c)
    expect(consentHash(c)).not.toBe(consentHash(base))
  })

  it('every field of a built consent is covered by a mutation (no field is silently outside the hash)', () => {
    const c = build()
    // the hash must see a field nobody listed: a new top-level key changes it too
    const extra = { ...clone(c), future: 1 } as PluginConsent
    expect(consentHash(extra)).not.toBe(consentHash(c))
  })

  it('same tree, different data dir or machine: args keep their symbols, hash is equal', () => {
    const a = build(plugin({ servers: [server('s1', { args: ['${PLUGIN_ROOT}/a'] })] }))
    const b = build(plugin({ servers: [server('s1', { args: ['${PLUGIN_ROOT}/a'] })] }))
    expect(consentHash(a)).toBe(consentHash(b))
    expect(a.mcp[0]!.args).toEqual(['${PLUGIN_ROOT}/a'])
  })
})

describe('buildConsent', () => {
  it('keeps symbols in command and args', () => {
    const c = build()
    expect(c.mcp[0]!.args).toEqual(['${PLUGIN_ROOT}/srv.js', '--data', '${PLUGIN_DATA}', '--cwd', '${PROJECT_DIR}'])
    const c2 = build(plugin({ servers: [server('s', { command: '${PLUGIN_ROOT}/bin/run' })] }))
    expect(c2.mcp[0]!.command).toBe('${PLUGIN_ROOT}/bin/run')
  })

  it('escapes control, bidi and zero-width characters as \\uXXXX in every display string', () => {
    const bad = 'a\u202eb\u200bc\nd\u0000e\u2066f\ufeffg\u0085h\u2028i'
    const esc = 'a\\u202eb\\u200bc\\u000ad\\u0000e\\u2066f\\ufeffg\\u0085h\\u2028i'
    const c = build(plugin({
      servers: [server('s', { command: bad, args: [bad], env: [{ name: bad, source: 'config', required: true }] })],
      notRun: { hooks: [{ event: bad, command: bad }], agents: [bad], bin: [bad], monitors: [bad], workflows: [bad], lsp: [bad], other: [bad], remoteMcp: [{ name: 'r', type: 'http', url: bad }], main: bad, scripts: [bad] },
      skills: [skill('a', { ignored: [bad] })],
    }))
    expect(c.mcp[0]!.command).toBe(esc)
    expect(c.mcp[0]!.args).toEqual([esc])
    expect(c.mcp[0]!.env[0]!.name).toBe(esc)
    expect(c.notRun.hooks[0]).toEqual({ event: esc, command: esc })
    for (const k of ['agents', 'bin', 'monitors', 'workflows', 'lsp', 'other', 'scripts'] as const) expect(c.notRun[k]).toEqual([esc])
    expect(c.notRun.remoteMcp[0]!.url).toBe(esc)
    expect(c.notRun.main).toBe(esc)
    expect(c.skills[0]!.ignored).toEqual([esc])
    expect(JSON.stringify(c)).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/)
  })

  it('escapes source path and url too', () => {
    const c = buildConsent(plugin(), { ...S, source: { kind: 'path', path: '/tmp/a\u202eb' } })
    expect(c.source).toEqual({ kind: 'path', path: '/tmp/a\\u202eb' })
  })

  it('masks secret-shaped env literals and keeps plain ones', () => {
    const key = ['sk', 'live', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('_')
    const gh = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
    const c = build(plugin({ servers: [server('s', { env: [
      { name: 'STRIPE', source: 'literal', required: true, value: key },
      { name: 'GH', source: 'literal', required: true, value: gh },
      { name: 'AUTH', source: 'literal', required: true, value: 'Bearer abcdef0123456789abcdef' },
      { name: 'PLAIN', source: 'literal', required: true, value: 'fast' },
      { name: 'FROM_CFG', source: 'config', required: true },
    ] })] }))
    const json = JSON.stringify(c)
    expect(json).not.toContain(key)
    expect(json).not.toContain(gh)
    expect(json).not.toContain('abcdef0123456789abcdef')
    const env = Object.fromEntries(c.mcp[0]!.env.map(e => [e.name, e]))
    expect(env.STRIPE!.value).toContain('***')
    expect(env.PLAIN!.value).toBe('fast')
    expect(env.FROM_CFG).not.toHaveProperty('value')
  })

  it('cleans claimed of control characters and clips it', () => {
    const c = build(plugin({ claimed: { name: 'N\u202eame\u0007', description: 'd\u200besc\nr' + 'x'.repeat(5000), author: 'a\u0000b', homepage: 'https://h\u202e' } }))
    expect(JSON.stringify(c.claimed)).not.toMatch(/[\u0000-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/)
    expect(c.claimed.name).toContain('Name')
    expect(c.claimed.description.length).toBeLessThanOrEqual(1000)
    expect(c.claimed.author).toContain('ab')
  })

  it('cuts a hook command over 4 KB and carries truncated', () => {
    const c = build(plugin({ notRun: { ...plugin().notRun, hooks: [{ event: 'Stop', command: 'x'.repeat(10_000) }] } }))
    expect(c.notRun.hooks[0]!.command.length).toBeLessThanOrEqual(4096 + 3)
    expect(c.warnings).toContain('truncated')
    expect(build().warnings).not.toContain('truncated')
  })

  it('carries the reader warnings, sorted and unique, and the extra kinds', () => {
    const c = build(plugin({ warnings: ['path_dropped', 'name_dropped', 'file_unreadable', 'hooks_not_run', 'path_dropped'] }))
    expect(c.warnings).toEqual(['file_unreadable', 'hooks_not_run', 'name_dropped', 'path_dropped'])
  })

  it('takes nothing that could be a setting value: output has only schema fields and config keys are metadata', () => {
    const c = build()
    expect(Object.keys(c).sort()).toEqual(['bytes', 'claimed', 'commands', 'config', 'files', 'format', 'id', 'integrity', 'mcp', 'notRun', 'skills', 'source', 'version', 'warnings'].sort())
    expect(Object.keys(c.config[0]!).sort()).toEqual(['key', 'required', 'sensitive', 'title', 'type'])
  })

  it('a plugin at the 5000-file cap gives a consent under 1 MB, skills capped at 500, truncated', () => {
    const big = 'd'.repeat(100_000)
    const skills = Array.from({ length: 5000 }, (_, i) => skill(`s${i}`, { description: big, ignored: Array.from({ length: 50 }, (_, j) => `file${j}-${big.slice(0, 500)}`) }))
    const commands = Array.from({ length: 5000 }, (_, i) => command(`c${i}`, { description: big }))
    const servers = Array.from({ length: 500 }, (_, i) => server(`m${i}`, { args: Array.from({ length: 500 }, () => big.slice(0, 2000)), env: Array.from({ length: 500 }, (_, j) => ({ name: `E${j}`, source: 'literal' as const, required: false, value: big })) }))
    const hooks = Array.from({ length: 5000 }, (_, i) => ({ event: `E${i}`, command: big }))
    const names = Array.from({ length: 5000 }, (_, i) => `n${i}-${big.slice(0, 500)}`)
    const c = build(plugin({ skills, commands, servers, notRun: { ...plugin().notRun, hooks, agents: names, bin: names, scripts: names, other: names, lsp: names, monitors: names, workflows: names, remoteMcp: names.map(n => ({ name: n, type: 't', url: big })) } }))
    expect(c.skills.length).toBeLessThanOrEqual(500)
    expect(c.skills.length).toBeGreaterThan(0)
    expect(c.warnings).toContain('truncated')
    expect(JSON.stringify(c).length).toBeLessThan(1_000_000)
    // the diff of two such consents stays inside the same bound
    const d = buildConsent(plugin({ skills, commands, servers, notRun: { ...plugin().notRun, hooks: hooks.slice(0, 10) } }), S, { consent: c, textHashes: new Map() })
    expect(JSON.stringify(d).length).toBeLessThan(1_000_000)
  })

  it('5000 modest skills: capped at exactly 500 with the truncated warning', () => {
    const c = build(plugin({ skills: Array.from({ length: 5000 }, (_, i) => skill(`s${i}`)) }))
    expect(c.skills.length).toBe(500)
    expect(c.warnings).toContain('truncated')
    expect(build(plugin({ skills: Array.from({ length: 500 }, (_, i) => skill(`s${i}`)) })).warnings).not.toContain('truncated')
  })

  it('previous consent: diff attached, source_changed when the origin differs', () => {
    const prev = build()
    const next = buildConsent(plugin({ version: '2.0.0', skills: [skill('a', { bodyHash: 'new' })] }), { ...S, integrity: 'sha256-ZZZ', source: { kind: 'git', url: 'https://github.com/evil/y', commit: 'def' } }, {
      consent: prev, textHashes: new Map([['skill:a', 'h-a'], ['skill:b', 'h-b'], ['command:go', 'c-go']]),
    })
    expect(next.diff?.fromVersion).toBe('1.0.0')
    expect(next.diff?.toVersion).toBe('2.0.0')
    expect(next.diff?.sourceChanged).toBe(true)
    expect(next.diff?.skills).toEqual({ added: [], removed: ['b'], textChanged: ['a'] })
    expect(next.warnings).toContain('source_changed')
    expect(build().diff).toBeUndefined()
  })

  it('previous consent without text hashes: unknown counts as changed, never as unchanged', () => {
    const prev = build()
    const next = buildConsent(plugin(), S, { consent: prev })
    expect(next.diff?.skills.textChanged).toEqual(['a', 'b'])
    expect(next.diff?.commands.textChanged).toEqual(['go'])
  })
})

describe('diffConsent', () => {
  const H = (c: PluginConsent) => new Map<string, string>([...c.skills.map(s => [`skill:${s.name}`, `h-${s.name}`] as const), ...c.commands.map(s => [`command:${s.name}`, `c-${s.name}`] as const)])
  const diff = (a: PluginConsent, b: PluginConsent, from = H(a), to = H(b)) => diffConsent(a, b, { from, to })
  const base = () => build()

  it('no change gives an empty diff', () => {
    const d = diff(base(), base())
    expect(d).toEqual({
      fromVersion: '1.0.0', toVersion: '1.0.0', sourceChanged: false,
      mcp: { added: [], removed: [], changed: [] }, skills: { added: [], removed: [], textChanged: [] }, commands: { added: [], removed: [], textChanged: [] },
      network: { added: [], removed: [] }, notRun: { hooksAdded: [], hooksRemoved: [] }, files: { added: 0, removed: 0, changed: 0 },
    })
  })

  it('added and removed server', () => {
    const to = build(plugin({ servers: [server('s2')] }))
    const d = diff(base(), to)
    expect(d.mcp.added).toEqual(['s2'])
    expect(d.mcp.removed).toEqual(['s1'])
  })

  it('changed fields per server', () => {
    const one = (extra: Partial<ParsedServer>) => diff(base(), build(plugin({ servers: [server('s1', extra)] }))).mcp.changed
    expect(one({ args: ['x'] })).toEqual([{ name: 's1', fields: ['args'] }])
    expect(one({ command: 'deno' })).toEqual([{ name: 's1', fields: ['command'] }])
    expect(one({ env: [{ name: 'MODE', source: 'literal', required: false, value: 'slow' }] })).toEqual([{ name: 's1', fields: ['env'] }])
    expect(one({ declared: { network: ['api.example.com'], cwd: 'write' } })).toEqual([{ name: 's1', fields: ['declared'] }])
    expect(one({ command: 'deno', args: ['x'] })).toEqual([{ name: 's1', fields: ['command', 'args'] }])
    expect(one({})).toEqual([])
  })

  it('an integrity-only upgrade shows no args change', () => {
    const to = build(plugin({ version: '1.0.1' }), { ...S, integrity: 'sha256-NEW' })
    const d = diff(base(), to)
    expect(d.mcp.changed).toEqual([])
    expect(d.fromVersion).toBe('1.0.0')
    expect(d.toVersion).toBe('1.0.1')
  })

  it('network: new host added, dropped host removed', () => {
    const to = build(plugin({ servers: [server('s1', { declared: { network: ['api.example.com', 'new.example.com'], cwd: 'read' } })] }))
    expect(diff(base(), to).network).toEqual({ added: ['new.example.com'], removed: [] })
    const to2 = build(plugin({ servers: [server('s1', { declared: { network: [], cwd: 'read' } })] }))
    expect(diff(base(), to2).network).toEqual({ added: [], removed: ['api.example.com'] })
  })

  it('hooks added and removed', () => {
    const np = { ...plugin().notRun, hooks: [{ event: 'Stop', command: 'curl evil' }] }
    const d = diff(base(), build(plugin({ notRun: np })))
    expect(d.notRun.hooksAdded).toEqual([{ event: 'Stop', command: 'curl evil' }])
    expect(d.notRun.hooksRemoved).toEqual([{ event: 'SessionStart', command: 'echo hi' }])
  })

  it('text changed compares body hashes, not descriptions; added and removed skills', () => {
    const a = base()
    const b = build(plugin({ skills: [skill('a', { description: 'new text' }), skill('c')] }))
    const d = diff(a, b)
    expect(d.skills).toEqual({ added: ['c'], removed: ['b'], textChanged: [] })
    const to = H(b)
    to.set('skill:a', 'different')
    expect(diff(a, b, H(a), to).skills.textChanged).toEqual(['a'])
    const to2 = H(b)
    to2.set('command:go', 'different')
    expect(diff(a, b, H(a), to2).commands.textChanged).toEqual(['go'])
    expect(diff(a, b, H(a), to2).skills.textChanged).toEqual([])
  })

  it('a missing hash on either side counts as changed', () => {
    const a = base()
    expect(diff(a, base(), new Map(), H(a)).skills.textChanged).toEqual(['a', 'b'])
    expect(diff(a, base(), H(a), new Map()).skills.textChanged).toEqual(['a', 'b'])
    expect(diff(a, base(), new Map(), new Map()).skills.textChanged).toEqual(['a', 'b'])
  })

  it('a skill and a command with one name do not shadow each other', () => {
    const a = build(plugin({ skills: [skill('x')], commands: [command('x')] }))
    const f = new Map([['skill:x', '1'], ['command:x', '1']])
    const t = new Map([['skill:x', '1'], ['command:x', '2']])
    const d = diffConsent(a, a, { from: f, to: t })
    expect(d.skills.textChanged).toEqual([])
    expect(d.commands.textChanged).toEqual(['x'])
  })

  it('source changed: another repo yes, a new commit or ref no', () => {
    const to = (source: PluginConsent['source']) => buildConsent(plugin(), { ...S, source })
    expect(diff(base(), to({ ...SRC, commit: 'zzz' })).sourceChanged).toBe(false)
    expect(diff(base(), to({ ...SRC, ref: 'v2', commit: 'zzz' })).sourceChanged).toBe(false)
    expect(diff(base(), to({ ...SRC, url: 'https://github.com/o/y' })).sourceChanged).toBe(true)
    expect(diff(base(), to({ ...SRC, subpath: 'sub' })).sourceChanged).toBe(true)
    expect(diff(base(), to({ kind: 'path', path: '/p' })).sourceChanged).toBe(true)
  })

  it('files counts', () => {
    expect(diff(base(), build(plugin(), { ...S, files: 14 })).files.added).toBe(4)
    expect(diff(base(), build(plugin(), { ...S, files: 7 })).files.removed).toBe(3)
  })
})

describe('effectiveGrants', () => {
  const decl = (network: string[], cwd: Declared['cwd'] = 'read'): Declared => ({ network, cwd })
  const ok = (r: ReturnType<typeof effectiveGrants>) => (r.ok ? r.grants : r.error)

  it('no grants: no hosts, cwd read', () => {
    expect(ok(effectiveGrants({ a: decl(['x.com']), b: null }, { servers: {} }))).toEqual({ servers: { a: { network: [], cwd: 'read' }, b: { network: [], cwd: 'read' } } })
  })

  it('the declared cwd caps the default', () => {
    expect(ok(effectiveGrants({ a: decl([], 'none') }, { servers: {} }))).toEqual({ servers: { a: { network: [], cwd: 'none' } } })
  })

  it('subset of declared is granted', () => {
    expect(ok(effectiveGrants({ a: decl(['x.com', 'y.com'], 'write') }, { servers: { a: { network: ['x.com'], cwd: 'write' } } }))).toEqual({ servers: { a: { network: ['x.com'], cwd: 'write' } } })
  })

  it('beyond the declaration: grants_exceed_declared', () => {
    expect(ok(effectiveGrants({ a: decl(['x.com']) }, { servers: { a: { network: ['y.com'], cwd: 'read' } } }))).toBe('grants_exceed_declared')
    expect(ok(effectiveGrants({ a: decl(['x.com']) }, { servers: { a: { network: ['x.com', 'y.com'], cwd: 'read' } } }))).toBe('grants_exceed_declared')
    expect(ok(effectiveGrants({ a: decl([]) }, { servers: { a: { network: ['x.com'], cwd: 'read' } } }))).toBe('grants_exceed_declared')
    expect(ok(effectiveGrants({ a: decl([], 'none') }, { servers: { a: { network: [], cwd: 'read' } } }))).toBe('grants_exceed_declared')
    expect(ok(effectiveGrants({ a: decl([], 'read') }, { servers: { a: { network: [], cwd: 'write' } } }))).toBe('grants_exceed_declared')
  })

  it('a server the plugin does not have: grants_exceed_declared', () => {
    expect(ok(effectiveGrants({ a: decl([]) }, { servers: { ghost: { network: [], cwd: 'none' } } }))).toBe('grants_exceed_declared')
  })

  it('wildcard and port grants only inside a declaration that covers them', () => {
    expect(ok(effectiveGrants({ a: decl(['*.x.com']) }, { servers: { a: { network: ['api.x.com'], cwd: 'read' } } }))).toEqual({ servers: { a: { network: ['api.x.com'], cwd: 'read' } } })
    expect(ok(effectiveGrants({ a: decl(['*.x.com']) }, { servers: { a: { network: ['*.api.x.com'], cwd: 'read' } } }))).toMatchObject({ servers: { a: { network: ['*.api.x.com'] } } })
    expect(ok(effectiveGrants({ a: decl(['api.x.com']) }, { servers: { a: { network: ['*.x.com'], cwd: 'read' } } }))).toBe('grants_exceed_declared')
    expect(ok(effectiveGrants({ a: decl(['api.x.com']) }, { servers: { a: { network: ['api.x.com:8443'], cwd: 'read' } } }))).toBe('grants_exceed_declared')
    expect(ok(effectiveGrants({ a: decl(['api.x.com:8443']) }, { servers: { a: { network: ['api.x.com:8443'], cwd: 'read' } } }))).toMatchObject({ servers: { a: { network: ['api.x.com:8443'] } } })
    expect(ok(effectiveGrants({ a: decl(['api.x.com']) }, { servers: { a: { network: ['api.x.com:*'], cwd: 'read' } } }))).toBe('grants_exceed_declared')
    expect(ok(effectiveGrants({ a: decl(['api.x.com:*']) }, { servers: { a: { network: ['api.x.com:22'], cwd: 'read' } } }))).toMatchObject({ servers: { a: { network: ['api.x.com:22'] } } })
  })

  it('claude format (no declaration): the user may fill hosts, still no bad hosts', () => {
    expect(ok(effectiveGrants({ a: null }, { servers: { a: { network: ['api.x.com'], cwd: 'write' } } }))).toEqual({ servers: { a: { network: ['api.x.com'], cwd: 'write' } } })
  })

  it.each(['*', '*.*', '127.0.0.1', '10.1.2.3', '169.254.169.254', '2852039166', '0x7f.1', '[::1]', 'localhost', 'foo.local', 'intranet', 'x.internal', 'a b.com', '', 'a@b.com', 'x.com/path', '*.localhost', '*.com:'])('refuses bad host %j', host => {
    for (const d of [null, decl([host]), decl(['*.com', host])]) {
      const r = effectiveGrants({ a: d }, { servers: { a: { network: [host], cwd: 'read' } } })
      expect(r).toEqual({ ok: false, error: 'bad_host' })
    }
  })

  it('bad_host wins over exceed', () => {
    expect(ok(effectiveGrants({ a: decl([]) }, { servers: { a: { network: ['127.0.0.1'], cwd: 'read' } } }))).toBe('bad_host')
  })

  it('prototype names never resolve', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const grants = JSON.parse(`{"servers":{"${name}":{"network":["x.com"],"cwd":"write"}}}`)
      expect(ok(effectiveGrants({ a: null }, grants))).toBe('grants_exceed_declared')
    }
    const inherited = effectiveGrants({ a: null }, { servers: Object.create({ a: { network: ['x.com'], cwd: 'write' } }) })
    expect(inherited.ok && inherited.grants.servers.a).toEqual({ network: [], cwd: 'read' })
    const r = effectiveGrants(JSON.parse('{"__proto__":{"network":[],"cwd":"read"},"a":null}'), { servers: {} })
    expect(r.ok && Object.keys(r.grants.servers)).toEqual(['a'])
    expect(({} as Record<string, unknown>).network).toBeUndefined()
  })

  it('dedupes hosts and does not mutate input', () => {
    const g = { servers: { a: { network: ['x.com', 'x.com'], cwd: 'read' as const } } }
    const snapshot = clone(g)
    expect(ok(effectiveGrants({ a: null }, g))).toEqual({ servers: { a: { network: ['x.com'], cwd: 'read' } } })
    expect(g).toEqual(snapshot)
  })
})

describe('intersectOnUpgrade', () => {
  const decl = (network: string[], cwd: Declared['cwd'] = 'read'): Declared => ({ network, cwd })
  const old = { servers: { a: { network: ['x.com', 'y.com'], cwd: 'write' as const } } }

  it('a host dropped from the declaration is gone; a new one is not granted', () => {
    expect(intersectOnUpgrade(old, { a: decl(['x.com', 'z.com'], 'write') })).toEqual({ servers: { a: { network: ['x.com'], cwd: 'write' } } })
  })
  it('cwd narrows to the new declaration and never widens', () => {
    expect(intersectOnUpgrade(old, { a: decl(['x.com'], 'read') }).servers.a!.cwd).toBe('read')
    expect(intersectOnUpgrade(old, { a: decl(['x.com'], 'none') }).servers.a!.cwd).toBe('none')
    expect(intersectOnUpgrade({ servers: { a: { network: [], cwd: 'none' } } }, { a: decl([], 'write') }).servers.a!.cwd).toBe('none')
  })
  it('a removed server loses its grant; a new server starts at the default', () => {
    expect(intersectOnUpgrade(old, { b: decl(['x.com'], 'write') })).toEqual({ servers: { b: { network: [], cwd: 'read' } } })
  })
  it('a new server capped by its declared cwd', () => {
    expect(intersectOnUpgrade({ servers: {} }, { b: decl([], 'none') })).toEqual({ servers: { b: { network: [], cwd: 'none' } } })
  })
  it('claude format keeps what the user filled', () => {
    expect(intersectOnUpgrade(old, { a: null })).toEqual(old)
  })
  it('declared went from a format with hosts to a wildcard that still covers', () => {
    expect(intersectOnUpgrade(old, { a: decl(['*.x.com', 'y.com']) }).servers.a!.network).toEqual(['y.com'])
    expect(intersectOnUpgrade({ servers: { a: { network: ['api.x.com'], cwd: 'read' } } }, { a: decl(['*.x.com']) }).servers.a!.network).toEqual(['api.x.com'])
  })
  it('prototype names and inherited keys never resolve', () => {
    const o = { servers: Object.create({ a: { network: ['x.com'], cwd: 'write' } }) }
    expect(intersectOnUpgrade(o, { a: decl(['x.com'], 'write') })).toEqual({ servers: { a: { network: [], cwd: 'read' } } })
    expect(intersectOnUpgrade(old, JSON.parse('{"__proto__":{"network":["x.com"],"cwd":"write"}}'))).toEqual({ servers: {} })
  })
  it('does not mutate its input', () => {
    const snap = clone(old)
    intersectOnUpgrade(old, { a: decl([]) })
    expect(old).toEqual(snap)
  })
})
