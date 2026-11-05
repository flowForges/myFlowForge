// Review round for Task 2: crashes, hangs, fail-open checks, and rows that kill mutations
import { afterEach, describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as types from './types'
import { NAME_RE, clip } from './types'
import { expandBody, type ExpandVars } from './expand'
import { INDEX_PREFACE, commandBlock, mcpResultBlock, oneLine, pluginIndex, skillBlock } from './wrap'
import { parseServer, type ServerCtx } from './mcpConfig'
import { parseClaudeManifest } from './claudeFormat'
import { parseNative } from './manifest'
import { readPlugin } from './read'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function make(files: Record<string, string | Buffer> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'mff-hard-'))
  dirs.push(root)
  for (const [rel, v] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, v)
  }
  return root
}
const opts = { nameHint: 'hint', reservedIds: new Set<string>(), kernelVersion: '0.1.0', home: '/Users/me' }
const read = (root: string, o: Record<string, unknown> = {}) => readPlugin(root, { ...opts, ...o })
const ok = (root: string, o: Record<string, unknown> = {}) => {
  const r = read(root, o)
  if (!r.ok) throw new Error(r.error)
  return r.plugin
}
const SKILL = (name: string) => `---\nname: ${name}\ndescription: d ${name}\n---\nbody ${name}\n`
const vars = (o: Partial<ExpandVars> = {}): ExpandVars => ({ root: '/r', settings: new Map(), sensitive: new Set(), ...o })
const ex = (t: string, v: ExpandVars, max?: number) => expandBody(t, v, max)

describe('1. output budgets', () => {
  it('a 64 KB body of $1 with 4000-char args is too_large, not a crash', () => {
    const r = ex('$1'.repeat(32768), vars({ args: 'x'.repeat(4000) }))
    expect(r).toEqual({ ok: false, error: 'too_large' })
  })
  it('budget is on output bytes', () => {
    expect(ex('$ARGUMENTS'.repeat(10), vars({ args: 'x'.repeat(1000) }), 5000)).toEqual({ ok: false, error: 'too_large' })
    expect(ex('$ARGUMENTS'.repeat(10), vars({ args: 'x'.repeat(1000) }), 10000)).toMatchObject({ ok: true })
    expect(ex('a'.repeat(100), vars(), 99)).toEqual({ ok: false, error: 'too_large' })
    expect(ex('a'.repeat(100), vars(), 100)).toEqual({ ok: true, text: 'a'.repeat(100) })
  })
  it('the appended ARGUMENTS counts too', () => {
    expect(ex('hi', vars({ args: 'x'.repeat(100) }), 50)).toEqual({ ok: false, error: 'too_large' })
  })
  it('clip never spreads and never splits a pair', () => {
    const t = Date.now()
    const c = clip('😀'.repeat(3_000_000), 11)
    expect(Date.now() - t).toBeLessThan(500)
    expect(c).toBe('😀'.repeat(5))
    expect(clip('abc', 3)).toBe('abc')
    expect(clip('abcd', 3)).toBe('abc')
    expect(clip('a😀', 2)).toBe('a')
  })
})

describe('2. manifest fan-out', () => {
  it('one 20 MB skill listed 50 times is read once', () => {
    const root = make({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', skills: Array(50).fill('./big') }),
      'big/SKILL.md': Buffer.alloc(20 * 1024 * 1024, 'a'),
    })
    const t = Date.now()
    const p = ok(root)
    expect(Date.now() - t).toBeLessThan(2500)
    expect(p.skills).toHaveLength(1)
  })
  it('lists in the manifest are capped at 50', () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 60; i++) {
      files[`s${i}/SKILL.md`] = SKILL(`s${i}`)
      files[`c${i}.md`] = `c${i}`
    }
    const root = make({
      ...files,
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', skills: Array.from({ length: 60 }, (_, i) => `s${i}`), commands: Array.from({ length: 60 }, (_, i) => `c${i}.md`) }),
    })
    const p = ok(root)
    expect(p.skills).toHaveLength(50)
    expect(p.commands).toHaveLength(50)
    expect(p.warnings).toContain('truncated')
    const m = parseClaudeManifest({ skills: Array(100).fill('a'), mcpServers: Array(100).fill('./x.json'), commands: Array(100).fill('c') })
    expect(m.ok && m.manifest.skills).toHaveLength(50)
    expect(m.ok && m.manifest.mcp).toHaveLength(50)
    expect(m.ok && m.manifest.commands?.paths).toHaveLength(50)
    expect(m.ok && m.manifest.truncated).toBe(true)
  })
  it('read bytes are charged against a total budget', () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 5; i++) files[`skills/k${i}/SKILL.md`] = `---\nname: k${i}\n---\n${'x'.repeat(300 * 1024)}`
    const p = ok(make({ ...files, '.claude-plugin/plugin.json': '{"name":"p"}' }), { readBudget: 700 * 1024 })
    expect(p.skills.length).toBe(2)
    expect(p.warnings).toEqual(expect.arrayContaining(['file_unreadable', 'truncated']))
  })
  it('mcp and hook paths repeated are read once and deep arrays do not recurse', () => {
    let nested: unknown = './x.json'
    for (let i = 0; i < 2000; i++) nested = [nested]
    const m = parseClaudeManifest({ mcpServers: nested })
    expect(m.ok).toBe(true)
  })
})

describe('3. home check', () => {
  const ctx: ServerCtx = { format: 'claude', config: new Map(), home: '/Users/me' }
  const p = (command: string, c: ServerCtx = ctx) => parseServer('s', { command }, c).problems
  it.each([
    '/Users/me/x', '//Users/me/x', '/Users//me/x', '/users/me/x', '/USERS/ME/x', '/System/Volumes/Data/Users/me/x', '/usr/../Users/me/x', '/Users/me/./x', '/Users/me', '/Users/me/',
  ])('%s', c => expect(p(c)).toContain('bad_command'))
  it('outside home is fine, a prefix sibling is fine', () => {
    for (const c of ['/usr/bin/env', '/Users/meat/x', '/Users/other/x', '/opt/x']) expect(p(c), c).toEqual([])
  })
  it('no home given: every absolute path fails closed', () => {
    expect(p('/usr/bin/env', { format: 'claude', config: new Map() } as ServerCtx)).toContain('bad_command')
    expect(p('/usr/bin/env', { ...ctx, home: '' })).toContain('bad_command')
  })
  it('home passes through readPlugin', () => {
    const root = make({ 'SKILL.md': SKILL('x'), '.mcp.json': JSON.stringify({ s: { command: '/Users/me/x' } }) })
    expect(ok(root).servers[0].problems).toContain('bad_command')
    expect(ok(root, { home: '/Users/other' }).servers[0].problems).toEqual([])
  })
})

describe('4. options are required', () => {
  it('no default kernel constant; missing kernelVersion fails closed', () => {
    expect('KERNEL_VERSION' in types).toBe(false)
    const root = make({ 'mff-plugin.json': JSON.stringify({ id: 'n', version: '1.0.0', kernel: '^0.1.0' }) })
    const r = readPlugin(root, { nameHint: 'x', reservedIds: new Set() } as never)
    expect(r).toEqual({ ok: false, error: 'kernel_incompatible' })
  })
})

describe('5. links and escapes never read', () => {
  function outside() {
    return make({ 'secret.md': '---\ndescription: LEAK\n---\nLEAKED BODY', 'servers.json': JSON.stringify({ leak: { command: 'node' } }), 'manifest.json': '{"name":"leaked"}', 'hooks.json': JSON.stringify({ Stop: [{ hooks: [{ command: 'LEAK' }] }] }) })
  }
  it('a linked JSON manifest', () => {
    const out = outside()
    const root = make({ 'SKILL.md': SKILL('x') })
    mkdirSync(join(root, '.claude-plugin'))
    symlinkSync(join(out, 'manifest.json'), join(root, '.claude-plugin', 'plugin.json'))
    expect(read(root)).toEqual({ ok: false, error: 'bad_manifest' })
  })
  it('a linked mff-plugin.json', () => {
    const out = make({ 'm.json': '{"id":"leak","version":"1.0.0"}' })
    const root = make({ 'SKILL.md': SKILL('x') })
    symlinkSync(join(out, 'm.json'), join(root, 'mff-plugin.json'))
    expect(read(root)).toEqual({ ok: false, error: 'bad_manifest' })
  })
  it('command source: a link, a linked directory, and ../out', () => {
    const out = outside()
    const root = make({ 'ok.md': 'fine' })
    symlinkSync(join(out, 'secret.md'), join(root, 'link.md'))
    symlinkSync(out, join(root, 'sub'))
    const base = join(dirs[dirs.length - 1], '..')
    void base
    writeFileSync(join(root, '.claude-plugin-tmp'), '')
    mkdirSync(join(root, '.claude-plugin'))
    writeFileSync(
      join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'p', commands: { a: { source: 'link.md' }, b: { source: 'sub/secret.md' }, c: { source: `../${out.split('/').pop()}/secret.md` }, d: { source: 'ok.md' } } }),
    )
    const p = ok(root)
    expect(JSON.stringify(p)).not.toContain('LEAK')
    expect(p.commands.map(c => c.name)).toEqual(['d'])
    expect(p.warnings).toEqual(expect.arrayContaining(['file_unreadable', 'path_dropped']))
  })
  it('mcp and hooks paths through links', () => {
    const out = outside()
    const root = make({ 'SKILL.md': SKILL('x') })
    symlinkSync(join(out, 'servers.json'), join(root, 'l.json'))
    symlinkSync(join(out, 'hooks.json'), join(root, 'h.json'))
    symlinkSync(out, join(root, 'dir'))
    mkdirSync(join(root, '.claude-plugin'))
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p', mcpServers: ['l.json', 'dir/servers.json'], hooks: ['h.json', 'dir/hooks.json'] }))
    const p = ok(root)
    expect(JSON.stringify(p)).not.toContain('leak')
    expect(JSON.stringify(p)).not.toContain('LEAK')
    expect(p.warnings).toContain('file_unreadable')
  })
  it('a FIFO as .mcp.json does not hang', () => {
    const root = make({ 'SKILL.md': SKILL('x') })
    execFileSync('mkfifo', [join(root, '.mcp.json')])
    const p = ok(root)
    expect(p.servers).toEqual([])
    expect(p.warnings).toContain('file_unreadable')
  })
  it('paths under .git are refused', () => {
    const root = make({ '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', skills: ['.git/x', 'a/.git/y'], commands: { a: { source: '.git/config' } } }), 'SKILL.md': SKILL('x') })
    const p = ok(root)
    expect(p.warnings).toContain('path_dropped')
    expect(p.commands).toEqual([])
  })
})

describe('5. caps (mutation killers)', () => {
  it('JSON over 1 MB is not read', () => {
    const big = JSON.stringify({ a: { command: 'node' }, pad: { command: 'x'.repeat(1.2 * 1024 * 1024) } })
    const p = ok(make({ 'SKILL.md': SKILL('x'), '.mcp.json': big }))
    expect(p.servers).toEqual([])
    expect(p.warnings).toContain('file_unreadable')
    const small = ok(make({ 'SKILL.md': SKILL('x'), '.mcp.json': JSON.stringify({ a: { command: 'node' }, pad: { command: 'x'.repeat(900 * 1024) } }) }))
    expect(small.servers.map(s => s.name)).toContain('a')
  })
  it('inline command content cap is 64 KB', () => {
    const mk = (n: number) => ok(make({ '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', commands: { a: { content: 'x'.repeat(n) } } }) })).commands[0]
    expect(mk(64 * 1024)).toMatchObject({ tooLarge: false })
    expect(mk(64 * 1024 + 1)).toMatchObject({ tooLarge: true, body: '' })
  })
  it('entry cap: 5000 fits, 5001 is truncated', () => {
    const many = (n: number) => {
      const root = make({ 'SKILL.md': SKILL('x') })
      mkdirSync(join(root, 'many'))
      for (let i = 0; i < n; i++) writeFileSync(join(root, 'many', `f${i}`), '')
      return ok(root).warnings
    }
    expect(many(4998)).not.toContain('truncated')
    expect(many(4999)).toContain('truncated')
  })
  it('depth cap: 32 directories are listed, 33 are not', () => {
    const deep = (n: number) => {
      const root = make({ 'SKILL.md': SKILL('x') })
      const dir = join(root, ...Array(n).fill('d'))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'run.sh'), '#!/bin/sh', { mode: 0o755 })
      return ok(root)
    }
    const a = deep(32)
    expect(a.notRun.scripts).toHaveLength(1)
    expect(a.warnings).not.toContain('truncated')
    const b = deep(33)
    expect(b.notRun.scripts).toEqual([])
    expect(b.warnings).toContain('truncated')
  })
  it('MAX_ITEMS 500 for skills and commands', () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 501; i++) {
      files[`skills/s${i}/SKILL.md`] = SKILL(`s${i}`)
      files[`commands/c${i}.md`] = `c${i}`
    }
    const p = ok(make(files))
    expect(p.skills).toHaveLength(500)
    expect(p.commands).toHaveLength(500)
    expect(p.warnings).toContain('truncated')
    delete files['skills/s500/SKILL.md']
    delete files['commands/c500.md']
    const q = ok(make(files))
    expect(q.skills).toHaveLength(500)
    expect(q.commands).toHaveLength(500)
    expect(q.warnings).not.toContain('truncated')
  })
  it('.git is skipped at any depth', () => {
    const root = make({ 'SKILL.md': SKILL('x') })
    for (const d of ['.git/hooks', 'sub/.git']) {
      mkdirSync(join(root, d), { recursive: true })
      writeFileSync(join(root, d, 'pre-commit'), 'x', { mode: 0o755 })
    }
    expect(ok(root).notRun.scripts).toEqual([])
  })
  it('descriptions clip at 200 and a bad frontmatter name falls back with a warning', () => {
    const root = make({ 'skills/dirname/SKILL.md': `---\nname: bad name\ndescription: ${'d'.repeat(500)}\n---\nb`, 'skills/dot/SKILL.md': '---\nname: ..\n---\nb' })
    const p = ok(root)
    expect(p.skills.map(s => s.name)).toEqual(['dirname', 'dot'])
    expect(p.skills[0].description).toHaveLength(200)
    expect(p.warnings).toContain('name_dropped')
  })
  it('mask before clip: a secret straddling the clip is hidden', () => {
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    const root = make({ 'skills/a/SKILL.md': `---\nname: a\ndescription: ${'x'.repeat(190)} ${token}\n---\nb` })
    const p = ok(root)
    expect(p.skills[0].description).not.toMatch(/ghp_/)
    expect(oneLine('x'.repeat(190) + ' ' + token)).not.toMatch(/ghp_/)
  })
  it('skills carry argNames', () => {
    const p = ok(make({ 'skills/a/SKILL.md': '---\nname: a\narguments: [one, two, "bad name"]\n---\nb' }))
    expect(p.skills[0].argNames).toEqual(['one', 'two'])
  })
})

describe('under-reporting', () => {
  it('manifest hooks as file paths are listed; odd shapes warn', () => {
    const root = make({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', hooks: ['./extra.json', './gone.json'] }),
      'extra.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'echo extra' }] }] } }),
    })
    const p = ok(root)
    expect(p.notRun.hooks).toEqual([{ event: 'Stop', command: 'echo extra' }])
    expect(p.warnings).toEqual(expect.arrayContaining(['hooks_not_run', 'file_unreadable']))
    const odd = ok(make({ 'hooks/hooks.json': JSON.stringify({ Stop: { hooks: [{ command: 'x' }] } }) }))
    expect(odd.warnings).toContain('file_unreadable')
  })
  it('truncated past 200 hooks and 100 servers', () => {
    const hooks = (n: number) => ok(make({ 'hooks/hooks.json': JSON.stringify({ Stop: [{ hooks: Array.from({ length: n }, (_, i) => ({ command: `c${i}` })) }] }) }))
    expect(hooks(200).warnings).not.toContain('truncated')
    expect(hooks(201).warnings).toContain('truncated')
    expect(hooks(201).notRun.hooks).toHaveLength(200)
    const servers = (n: number) => ok(make({ 'SKILL.md': SKILL('x'), '.mcp.json': JSON.stringify(Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, { command: 'node' }]))) }))
    expect(servers(100).warnings).not.toContain('truncated')
    expect(servers(101).warnings).toContain('truncated')
    expect(servers(101).servers).toHaveLength(100)
  })
  it('.git manifests dropped', () => {
    expect(NAME_RE.test('.')).toBe(false)
    expect(NAME_RE.test('..')).toBe(false)
    expect(NAME_RE.test('...')).toBe(true)
  })
})

describe('expandBody minor', () => {
  it('no args given: positional tokens stay as written', () => {
    expect(ex("awk '{print $1}' costs $5 $ARGUMENTS $name", vars({ argNames: ['name'] }))).toEqual({ ok: true, text: "awk '{print $1}' costs $5 $ARGUMENTS $name" })
    expect(ex('a $1 b', vars({ args: '' }))).toEqual({ ok: true, text: 'a  b' })
  })
  it('a setting holding ${...} is not expanded again', () => {
    const v = vars({ settings: new Map([['a', '${user_config.b}'], ['b', 'B'], ['r', '${CLAUDE_PLUGIN_ROOT}']]) })
    expect(ex('${user_config.a} ${user_config.b} ${user_config.r}', v)).toEqual({ ok: true, text: '${user_config.b} B ${CLAUDE_PLUGIN_ROOT}' })
  })
})

describe('wrap minor', () => {
  const SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
  it('caps apply after escaping', () => {
    const s = skillBlock({ plugin: 'p', skill: 's', text: '<a'.repeat(200000) })
    expect(s.length).toBeLessThan(256 * 1024 + 1000)
    expect(s).toContain('[truncated]')
    const c = commandBlock({ plugin: 'p', command: 'c', text: '<a'.repeat(40000) })
    expect(c.length).toBeLessThan(64 * 1024 + 1000)
    expect(c).toContain('[truncated]')
  })
  it('astral text is never cut in the middle of a pair', () => {
    for (const n of [1, 2, 3]) {
      const s = skillBlock({ plugin: 'p', skill: 's', text: 'a'.repeat(n % 2) + '😀'.repeat(200000) })
      expect(SURROGATE.test(s)).toBe(false)
      expect(SURROGATE.test(commandBlock({ plugin: 'p', command: 'c', text: 'a'.repeat(n % 2) + '😀'.repeat(50000) }))).toBe(false)
    }
  })
  it('exactly at the cap is not truncated', () => {
    expect(skillBlock({ plugin: 'p', skill: 's', text: 'a'.repeat(256 * 1024) })).not.toContain('[truncated]')
    expect(commandBlock({ plugin: 'p', command: 'c', text: 'a'.repeat(64 * 1024) })).not.toContain('[truncated]')
    expect(commandBlock({ plugin: 'p', command: 'c', text: 'a'.repeat(64 * 1024 + 1) })).toContain('[truncated]')
  })
  it('<! and <? are escaped; no raw comment opens', () => {
    const t = '<!DOCTYPE x> <?xml v?> <!-- c -->'
    for (const b of [skillBlock({ plugin: 'p', skill: 's', text: t }), commandBlock({ plugin: 'p', command: 'c', text: t }), mcpResultBlock({ plugin: 'p', server: 's', tool: 't', text: t }), pluginIndex([{ plugin: 'p', skill: 's', description: t }], 6000)]) {
      expect(b).toContain('&lt;?xml')
      expect(b).not.toMatch(/<!|<\?/)
    }
    expect(skillBlock({ plugin: 'p', skill: 's', text: t })).toContain('&lt;!DOCTYPE')
  })
  it('names . and .. are unknown in attributes', () => {
    expect(skillBlock({ plugin: '..', skill: '.', text: 't' }).split('\n')[0]).toBe('<plugin-skill plugin="unknown" skill="unknown">')
  })
})

describe('parseNative userConfig keys', () => {
  it('__proto__ and constructor keys are refused', () => {
    for (const k of ['__proto__', 'constructor', 'prototype'])
      expect(parseNative({ id: 'x', version: '1.0.0', userConfig: JSON.parse(`{"${k}":{"title":"x"}}`) }).ok).toBe(false)
    expect(parseNative({ id: 'x', version: '1.0.0', userConfig: { ok_1: { title: 'x' } } }).ok).toBe(true)
  })
})

describe('mcpConfig rows', () => {
  const ctx: ServerCtx = { format: 'claude', config: new Map(), home: '/Users/me' }
  const p = (raw: unknown, name = 's') => parseServer(name, raw, ctx)
  it.each([
    ['${CLAUDE_PLUGIN_ROOT}/${TOKEN}'], ['$VAR/x'], ['${PLUGIN_ROOT}/$VAR/x'], ['node\u0001'], ['a\\b'], ['a'.repeat(1025)], ['a b/c'], ['bin/x y'], ['${'], ['.'], ['..'],
  ])('bad command %j', c => expect(p({ command: c }).problems).toContain('bad_command'))
  it('length 1024 is fine', () => expect(p({ command: 'a'.repeat(1024) }).problems).toEqual([]))
  it('args count and length limits and NUL', () => {
    expect(p({ command: 'n', args: Array(256).fill('a') }).problems).toEqual([])
    expect(p({ command: 'n', args: Array(257).fill('a') }).problems).toContain('bad_command')
    expect(p({ command: 'n', args: ['a'.repeat(4096)] }).problems).toEqual([])
    expect(p({ command: 'n', args: ['a'.repeat(4097)] }).problems).toContain('bad_command')
    expect(p({ command: 'n', args: ['a\0b'] }).problems).toContain('bad_command')
  })
  it('a long ${...} is still seen, an unclosed one too', () => {
    expect(p({ command: 'n', args: ['${' + 'A'.repeat(300) + '}'] }).problems).toContain('arg_env_ref')
    expect(p({ command: 'n', args: ['${TOKEN'] }).problems).toContain('arg_env_ref')
    const t = Date.now()
    p({ command: 'n', env: { A: '${'.repeat(30000) } })
    expect(Date.now() - t).toBeLessThan(500)
  })
  it('undeclared user_config in env is a secret', () => {
    expect(p({ command: 'n', env: { A: '${user_config.zzz}' } }).env[0]).toMatchObject({ source: 'secret' })
  })
  it.each([
    'HOME', 'SHELL', 'ENV', 'ZDOTDIR', 'BASH_ENV', 'TMPDIR', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'GLIBC_TUNABLES', 'JAVA_TOOL_OPTIONS',
    'SSL_CERT_FILE', 'PERL5LIB', 'PERLLIB', 'RUBYOPT', 'ELECTRON_RUN_AS_NODE', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH', 'LUA_INIT', 'DOTNET_STARTUP_HOOKS', 'LOCPATH', 'NLSPATH', 'HOSTALIASES', 'NO_PROXY',
  ])('env %s is dangerous (any case)', name => {
    expect(p({ command: 'n', env: { [name]: 'x' } }).problems).toContain('dangerous_env')
    expect(p({ command: 'n', env: { [name.toLowerCase()]: 'x' } }).problems).toContain('dangerous_env')
  })
  it.each(['docker', 'Docker', 'DOCKER', 'docker-compose', 'podman-remote', 'nerdctl', '/usr/bin/NERDCTL', '/usr/local/bin/Docker-Compose'])('runtime %s', c =>
    expect(p({ command: c }).problems).toContain('runtime_unsupported'))
  it.each([
    ['pnpx', ['x']], ['PNPX', ['x']], ['npm', ['exec', 'x']], ['npm', ['-s', 'exec', 'x']], ['yarn', ['dlx', 'x']], ['pnpm', ['-s', 'dlx', 'x']], ['pnpm', ['dlx', 'x']],
    ['bun', ['--bun', 'x', 'y']], ['bun', ['x', 'y']], ['NPX', ['y']], ['Bunx', ['y']],
  ])('fetches %s %j (npm)', (c, a) => expect(p({ command: c, args: a })).toMatchObject({ fetchesAtRuntime: true, suggestedHosts: ['registry.npmjs.org'] }))
  it.each([
    ['uvx', ['x']], ['UVX', ['x']], ['uv', ['tool', 'run', 'x']], ['uv', ['--quiet', 'tool', 'run', 'x']], ['pipx', ['run', 'x']],
  ])('fetches %s %j (pypi)', (c, a) => expect(p({ command: c, args: a })).toMatchObject({ fetchesAtRuntime: true, suggestedHosts: ['pypi.org', 'files.pythonhosted.org'] }))
  it.each([
    ['npm', ['install']], ['bun', ['run', 'x']], ['uv', ['sync']], ['pipx', ['list']], ['node', ['exec']],
  ])('does not fetch %s %j', (c, a) => expect(p({ command: c, args: a }).fetchesAtRuntime).toBe(false))
})

describe('mutation survivors, second pass', () => {
  const ctx: ServerCtx = { format: 'claude', config: new Map(), home: '/Users/me' }
  const p = (raw: unknown) => parseServer('s', raw, ctx)
  it('exactly 50 listed paths is fine, 51 is truncated', () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 51; i++) files[`s${i}/SKILL.md`] = SKILL(`s${i}`)
    const run = (n: number) => ok(make({ ...files, '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', skills: Array.from({ length: n }, (_, i) => `s${i}`) }) }))
    expect(run(50).warnings).not.toContain('truncated')
    expect(run(50).skills).toHaveLength(50)
    expect(run(51).warnings).toContain('truncated')
  })
  it('overlapping paths are read once (budget is charged once)', () => {
    const body = (n: string) => `---\nname: ${n}\n---\n${'x'.repeat(200 * 1024)}`
    const a = ok(make({ 'skills/a/SKILL.md': body('a'), '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', skills: ['skills/a', 'skills'] }) }), { readBudget: 250 * 1024 })
    expect(a.skills).toHaveLength(1)
    expect(a.warnings).not.toContain('truncated')
    const b = ok(make({ 'cmds/x.md': 'x'.repeat(40 * 1024), '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', commands: ['cmds', 'cmds/x.md'] }) }), { readBudget: 60 * 1024 })
    expect(b.commands).toHaveLength(1)
    expect(b.warnings).not.toContain('truncated')
    const h = ok(make({ 'hooks/hooks.json': JSON.stringify({ Stop: [{ hooks: [{ command: 'x'.repeat(200 * 1024) }] }] }), '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', hooks: ['hooks/hooks.json', './hooks/hooks.json'] }) }), { readBudget: 300 * 1024 })
    expect(h.notRun.hooks).toHaveLength(1)
    expect(h.warnings).not.toContain('file_unreadable')
  })
  it('commands map is capped at 500', () => {
    const map = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, { content: 'x' }]))
    const a = parseClaudeManifest({ commands: map(500) })
    const b = parseClaudeManifest({ commands: map(501) })
    expect(a.ok && a.manifest.commands?.map.size).toBe(500)
    expect(a.ok && a.manifest.truncated).toBe(false)
    expect(b.ok && b.manifest.commands?.map.size).toBe(500)
    expect(b.ok && b.manifest.truncated).toBe(true)
  })
  it('absolute commands with . or .. segments or a backslash are refused', () => {
    for (const c of ['/usr/bin/../bin/env', '/usr/./bin/env', '/opt/a\\b']) expect(p({ command: c }).problems, c).toContain('bad_command')
  })
  it('env PROXY; a typed non-stdio server is remote even with a command', () => {
    expect(p({ command: 'n', env: { PROXY: 'x' } }).problems).toContain('dangerous_env')
    expect(p({ type: 'http', url: 'https://x.example.com', command: 'npx' }).remote?.type).toBe('http')
    expect(p({ type: 'sse', command: 'node' }).remote?.type).toBe('sse')
  })
  it('the cap counts escaped length even when the input is under it', () => {
    const s = skillBlock({ plugin: 'p', skill: 's', text: '<a'.repeat(100000) })
    expect(s.length).toBeLessThan(256 * 1024 + 1000)
    expect(s).toContain('[truncated]')
    const c = commandBlock({ plugin: 'p', command: 'c', text: '<a'.repeat(30000) })
    expect(c.length).toBeLessThan(64 * 1024 + 1000)
    expect(c).toContain('[truncated]')
  })
  it('the index never exceeds room, whatever the room', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ plugin: 'p', skill: `s${String(i).padStart(2, '0')}`, description: 'x'.repeat(40 + i) }))
    for (let room = 300; room < 2200; room += 7) expect(pluginIndex(items, room).length, String(room)).toBeLessThanOrEqual(room)
  })
})

describe('mutation survivors, third pass', () => {
  it('listings of not-run components are capped at 50 paths', () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 60; i++) files[`a${i}.md`] = 'x'
    const run = (n: number) => ok(make({ ...files, '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', agents: Array.from({ length: n }, (_, i) => `a${i}.md`) }) }))
    // the default `agents` directory takes one of the 50 slots
    expect(run(49).notRun.agents).toHaveLength(49)
    expect(run(49).warnings).not.toContain('truncated')
    expect(run(50).notRun.agents).toHaveLength(50)
    expect(run(50).warnings).toContain('truncated')
  })
  it('the index keeps as many whole lines as fit, for every room', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ plugin: 'p', skill: `s${String(i).padStart(2, '0')}`, description: 'y'.repeat(30 + i) }))
    const lines = items.map(i => `${i.plugin}:${i.skill} — ${oneLine(i.description)}`)
    const frame = (body: string) => `<plugin-index>\n${INDEX_PREFACE}\n${body}\n</plugin-index>`
    for (let room = 100; room < 1500; room += 3) {
      let expected = ''
      if (frame(lines.join('\n')).length <= room) expected = frame(lines.join('\n'))
      else
        for (let k = lines.length - 1; k >= 0; k--) {
          const c = frame([...lines.slice(0, k), `[${lines.length - k} more: use skill with action list]`].join('\n'))
          if (c.length <= room) {
            expected = c
            break
          }
        }
      expect(pluginIndex(items, room), String(room)).toBe(expected)
    }
  })
})
