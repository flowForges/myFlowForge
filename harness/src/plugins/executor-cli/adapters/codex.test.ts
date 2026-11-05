import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { credentialRoots } from '../../../lib/fs/paths'
import { codexAdapter, filesystemMap, tomlString } from './codex'
import { foldEvent, WRITE_RUN_SUFFIX, type BuildInput, type RunEvent, type RunState } from './types'

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../test/fixtures/executors/${name}`, import.meta.url)), 'utf8').split('\n').filter(Boolean)

const input = (over: Partial<BuildInput> = {}): BuildInput => ({
  prompt: 'do it',
  cwd: '/work/repo',
  readOnly: false,
  isolation: 'own',
  denyRead: [],
  readOnlyPaths: [],
  network: false,
  ...over,
})
const state = (over: Partial<RunState> = {}): RunState => ({
  code: 0, signal: null, completed: false, sawResult: false, errors: [], timedOut: false, stalled: false, cancelled: false, ...over,
})

/** 本测试只认这些形状:basic string、嵌套 inline table。解析不了就抛,说明产出不是合法的 TOML */
function parseToml(src: string): unknown {
  let i = 0
  const fail = (why: string): never => { throw new Error(`${why} at ${i}: ${src}`) }
  const str = (): string => {
    if (src[i++] !== '"') fail('expected string')
    let out = ''
    while (i < src.length) {
      const c = src[i++]
      if (c === '"') return out
      if (c.charCodeAt(0) < 0x20 && c !== '\t' || c === '\x7f') fail('raw control character')
      if (c !== '\\') { out += c; continue }
      const e = src[i++]
      if (e === 'u') { out += String.fromCharCode(parseInt(src.slice(i, i + 4), 16)); i += 4; continue }
      const m: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }
      if (!(e in m)) fail('bad escape')
      out += m[e]
    }
    return fail('unterminated')
  }
  const value = (): unknown => {
    if (src[i] === '"') return str()
    if (src[i] !== '{') fail('expected value')
    i++
    const out: Record<string, unknown> = {}
    while (src[i] !== '}') {
      const k = str()
      if (k in out) fail(`duplicate key ${k}`)
      if (src[i++] !== '=') fail('expected =')
      out[k] = value()
      if (src[i] === ',') i++
      else if (src[i] !== '}') fail('expected , or }')
    }
    i++
    return out
  }
  const v = value()
  if (i !== src.length) fail('trailing')
  return v
}

const flag = (args: string[], prefix: string) => args.find(a => a.startsWith(prefix))
const fsTable = (args: string[]) =>
  parseToml(flag(args, 'permissions.mffai.filesystem=')!.slice('permissions.mffai.filesystem='.length)) as Record<string, unknown>

/** cwd 可写,cwd 的 CLI 配置和嵌套仓库的 hooks、config 不行(实测 0.154) */
const PROJECT_ROOTS = { '.': 'write', '.codex': 'read', '.qoder': 'read', '*/**/.git/hooks/**': 'none', '*/**/.git/config': 'none' }

describe('codex buildArgs', () => {
  it('matches spec §8.1 exactly', () => {
    const { args, stdin } = codexAdapter.buildArgs(input({ denyRead: ['/h/.ssh'], readOnlyPaths: ['/work/repo/gen'], model: 'gpt-x' }))
    expect(args).toEqual([
      'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-C', '/work/repo',
      '-c', 'approval_policy="never"',
      '-c', 'web_search="disabled"',
      '-c', 'default_permissions="mffai"',
      '-c', 'permissions.mffai.filesystem={":root"="read",":project_roots"={"."="write",".codex"="read",".qoder"="read","*/**/.git/hooks/**"="none","*/**/.git/config"="none"},":tmpdir"="write","/h/.ssh"="none","/work/repo/gen"="read"}',
      '-c', 'permissions.mffai.network={enabled=false}',
      '-m', 'gpt-x',
      '-',
    ])
    expect(stdin).toBe(`do it\n\n${WRITE_RUN_SUFFIX}`)
  })

  it('every credential root and the data dir are "<path>"="none"', () => {
    const roots = credentialRoots('/h', 'darwin', {})
    expect(roots.length).toBeGreaterThan(5)
    const denyRead = [...roots, '/h/.myFlowForge/mff-ai']
    const raw = flag(codexAdapter.buildArgs(input({ denyRead })).args, 'permissions.mffai.filesystem=')!
    for (const p of denyRead) expect(raw).toContain(`${tomlString(p)}="none"`)
    const table = fsTable(codexAdapter.buildArgs(input({ denyRead, readOnly: true })).args)
    for (const p of denyRead) expect(table[p]).toBe('none')
  })

  const matrix = [true, false].flatMap(readOnly =>
    (['own', 'wrapped', 'none'] as const).flatMap(isolation =>
      [true, false].flatMap(network => [undefined, 'gpt-x'].map(model => ({ readOnly, isolation, network, model }))),
    ),
  )

  it('--ignore-rules is always there; bypass, -s and danger-full-access never are', () => {
    for (const m of matrix) {
      const { args } = codexAdapter.buildArgs(input(m))
      expect(args).toContain('--ignore-rules')
      expect(args).toContain('--ignore-user-config')
      expect(args.at(-1)).toBe('-')
      for (const bad of ['--dangerously-bypass-approvals-and-sandbox', '-s', '--sandbox', '--full-auto']) expect(args).not.toContain(bad)
      expect(args.join(' ')).not.toContain('danger-full-access')
    }
  })

  it('the prompt reaches stdin and never argv, even when it is a flag', () => {
    for (const prompt of ['--dangerously-bypass-approvals-and-sandbox', '-s danger-full-access', 'plain-marker-text']) {
      for (const m of matrix) {
        const { args, stdin } = codexAdapter.buildArgs(input({ ...m, prompt }))
        expect(stdin!.startsWith(prompt)).toBe(true)
        expect(args.join('\0')).not.toContain(prompt)
        expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
      }
    }
  })

  it('stdin is redacted; only write runs get the suffix, and a PEM with no END cannot swallow it', () => {
    const key = 'sk-abcdefghijklmnopqrstuvwxyz'
    const rw = codexAdapter.buildArgs(input({ prompt: `use ${key}` }))
    expect(rw.stdin).not.toContain(key)
    expect(rw.stdin).toBe(`use ***\n\n${WRITE_RUN_SUFFIX}`)
    expect(codexAdapter.buildArgs(input({ prompt: `use ${key}`, readOnly: true })).stdin).toBe('use ***')
    const pem = codexAdapter.buildArgs(input({ prompt: '-----BEGIN RSA PRIVATE KEY-----\nAAAA' }))
    expect(pem.stdin).toBe(`***\n\n${WRITE_RUN_SUFFIX}`)
    expect(codexAdapter.buildArgs(input({ prompt: key })).args.join(' ')).not.toContain(key)
  })

  it('readOnly removes :project_roots and keeps every narrowing entry', () => {
    const rw = fsTable(codexAdapter.buildArgs(input({ denyRead: ['/h/.ssh'] })).args)
    const ro = fsTable(codexAdapter.buildArgs(input({ denyRead: ['/h/.ssh'], readOnly: true })).args)
    expect(rw[':project_roots']).toEqual(PROJECT_ROOTS)
    expect(ro).toEqual({ ':root': 'read', ':tmpdir': 'write', '/h/.ssh': 'none' })
  })

  it('network must be exactly true to open the network', () => {
    const odd = codexAdapter.buildArgs(input({ network: 'true,x=1' as never })).args
    expect(flag(odd, 'permissions.mffai.network=')).toBe('permissions.mffai.network={enabled=false}')
  })

  it('network:true flips the network table and nothing else', () => {
    const off = codexAdapter.buildArgs(input()).args
    const on = codexAdapter.buildArgs(input({ network: true })).args
    expect(flag(off, 'permissions.mffai.network=')).toBe('permissions.mffai.network={enabled=false}')
    expect(flag(on, 'permissions.mffai.network=')).toBe('permissions.mffai.network={enabled=true}')
    expect(on.filter(a => !a.startsWith('permissions.mffai.network='))).toEqual(off.filter(a => !a.startsWith('permissions.mffai.network=')))
  })

  it('a bad model never reaches argv', () => {
    for (const model of ['--foo', '-s', '', 'a b', 'a\nb', 'x'.repeat(101), '--dangerously-bypass-approvals-and-sandbox']) {
      expect(() => codexAdapter.buildArgs(input({ model }))).toThrow()
    }
  })

  it('a cwd that is not absolute is refused', () => {
    expect(() => codexAdapter.buildArgs(input({ cwd: '-x' }))).toThrow()
    expect(() => codexAdapter.buildArgs(input({ cwd: '' }))).toThrow()
  })
})

describe('filesystemMap and tomlString', () => {
  it('a path with " and \\ survives', () => {
    const p = '/h/we"ird\\dir'
    expect(tomlString(p)).toBe('"/h/we\\"ird\\\\dir"')
    expect(parseToml(tomlString(p))).toBe(p)
    expect(fsTable(codexAdapter.buildArgs(input({ denyRead: [p] })).args)[p]).toBe('none')
  })

  it('control characters are escaped, so one argv value stays one valid TOML line', () => {
    const p = '/h/a\nb\tc\rd\be\ff\u0000g\u001fh\u007fi'
    const s = tomlString(p)
    // eslint-disable-next-line no-control-regex
    expect(s).not.toMatch(/[\u0000-\u001f\u007f]/)
    expect(parseToml(s)).toBe(p)
    // 换行想提前结束表、再塞一个键:仍只是这一个键的内容
    const attack = '/h/x"="write","/etc'
    const table = fsTable(codexAdapter.buildArgs(input({ denyRead: [attack] })).args)
    expect(table[attack]).toBe('none')
    expect(table['/etc']).toBeUndefined()
    expect(table['/h/x']).toBeUndefined()
  })

  it('never has an empty key', () => {
    const table = parseToml(filesystemMap({ denyRead: ['', '/h/.ssh', ''], readOnlyPaths: [''], readOnly: false })) as Record<string, unknown>
    expect(Object.keys(table)).toEqual([':root', ':project_roots', ':tmpdir', '/h/.ssh'])
    expect(filesystemMap({ denyRead: [''], readOnlyPaths: [], readOnly: false })).not.toContain('""')
  })

  it('keepRead: the git dir stays readable under a none top, unless a rule denies it, and no glob key', () => {
    const table = parseToml(filesystemMap({ denyRead: ['/p', '/p/.git/x', '/q/.git'], keepRead: ['/p/.git', '/q/.git', '/r[1]/.git'], readOnlyPaths: [], readOnly: false })) as Record<string, unknown>
    expect(table['/p']).toBe('none')
    expect(table['/p/.git']).toBe('read')
    expect(table['/p/.git/x']).toBe('none')
    expect(table['/q/.git']).toBe('none')
    expect(table['/r[1]/.git']).toBeUndefined()
  })

  it('a path listed twice stays one key and none beats read', () => {
    // 重复键是非法 TOML;Codex 解析不了 -c 时不保证报错
    const table = parseToml(filesystemMap({
      denyRead: ['/h/.ssh', '/h/.ssh/', '/h/a/../.ssh', '/both'],
      readOnlyPaths: ['/both', '/both/', '/ro', '/ro'],
      readOnly: false,
    })) as Record<string, unknown>
    expect(table['/h/.ssh']).toBe('none')
    expect(table['/both']).toBe('none')
    expect(table['/ro']).toBe('read')
    expect(Object.keys(table)).toHaveLength(6)
  })

  it('refuses a relative entry rather than dropping a deny or colliding with :root', () => {
    for (const p of [':root', ':project_roots', '.', 'src/gen', '~/secrets']) {
      expect(() => filesystemMap({ denyRead: [p], readOnlyPaths: [], readOnly: false })).toThrow()
      expect(() => filesystemMap({ denyRead: [], readOnlyPaths: [p], readOnly: false })).toThrow()
    }
    expect(parseToml(filesystemMap({ denyRead: ['/'], readOnlyPaths: [], readOnly: false }))).toMatchObject({ '/': 'none' })
  })
})

describe('a read entry cannot reopen a none root', () => {
  const table = (denyRead: string[], readOnlyPaths: string[]) =>
    parseToml(filesystemMap({ denyRead, readOnlyPaths, readOnly: false })) as Record<string, unknown>

  it('deny write(~/.ssh/config) does not make the file readable', () => {
    const denyRead = credentialRoots('/h', 'darwin', {})
    expect(denyRead).toContain('/h/.ssh')
    const t = fsTable(codexAdapter.buildArgs(input({ denyRead, readOnlyPaths: ['/h/.ssh/config'] })).args)
    expect(t['/h/.ssh']).toBe('none')
    expect(t['/h/.ssh/config']).toBeUndefined()
  })

  it('at or under a none root, with any spelling, nothing is emitted', () => {
    for (const r of ['/s', '/s/', '/s/a', '/s/a/', '/s/a/b/c', '/s/x/../a']) {
      expect(table(['/s'], [r])).toEqual({ ':root': 'read', ':project_roots': PROJECT_ROOTS, ':tmpdir': 'write', '/s': 'none' })
    }
    expect(table(['/s/'], ['/s/a'])['/s/a']).toBeUndefined()
    expect(table(['/'], ['/anything'])['/anything']).toBeUndefined()
  })

  it('a sibling that only shares the prefix stays read, and none under read is kept', () => {
    expect(table(['/s'], ['/sibling'])['/sibling']).toBe('read')
    expect(table(['/s/a'], ['/s'])).toMatchObject({ '/s': 'read', '/s/a': 'none' })
  })
})

describe('glob characters in a profile path', () => {
  const GLOBS = ['/w/cw[1]d', '/w/a*b', '/w/a?b', '/w/[x', '/w/a]b', '/w/{p}', '/w/a{b,c}']

  it('a cwd like cw[1]d is unenforceable: never own, and reported', () => {
    const i = input({ cwd: '/w/cw[1]d', denyRead: ['/w/cw[1]d/hid'], isolation: 'none' })
    expect(codexAdapter.buildArgs(i).unenforceable).toEqual(['codex_path_glob'])
    expect(codexAdapter.profileGaps!(i)).toEqual(['codex_path_glob'])
    expect(() => codexAdapter.buildArgs({ ...i, isolation: 'own' })).toThrow(/codex_path_glob/)
    expect(() => codexAdapter.buildArgs({ ...i, isolation: 'wrapped' })).toThrow(/codex_path_glob/)
  })

  it('each metacharacter in cwd, a deny root or a rule path counts', () => {
    for (const p of GLOBS) {
      expect(codexAdapter.profileGaps!({ cwd: p, denyRead: [], readOnlyPaths: [] })).toEqual(['codex_path_glob'])
      expect(codexAdapter.profileGaps!({ cwd: '/w', denyRead: [p], readOnlyPaths: [] })).toEqual(['codex_path_glob'])
      expect(codexAdapter.profileGaps!({ cwd: '/w', denyRead: [], readOnlyPaths: [p] })).toEqual(['codex_path_glob'])
      expect(() => codexAdapter.buildArgs(input({ denyRead: [p] }))).toThrow(/codex_path_glob/)
    }
  })

  it('characters Codex takes literally do not count', () => {
    for (const p of ['/w/a\\b', '/w/a b', '/w/a"b', '/w/a,b', '/w/空白']) {
      const i = input({ cwd: p, denyRead: [p], isolation: 'own' })
      expect(codexAdapter.profileGaps!(i)).toEqual([])
      expect(codexAdapter.buildArgs(i).unenforceable).toBeUndefined()
    }
  })

  it('a read entry already dropped under a none root is not in the profile, so it does not count', () => {
    expect(codexAdapter.profileGaps!({ cwd: '/w', denyRead: ['/s'], readOnlyPaths: ['/s/a[1]'] })).toEqual([])
  })

  it('degraded, the profile still runs: glob read keys are left out because Codex refuses them with exit 1', () => {
    const { args } = codexAdapter.buildArgs(input({ cwd: '/w/cw[1]d', isolation: 'none', denyRead: ['/w/cw[1]d/hid'], readOnlyPaths: ['/w/cw[1]d/gen', '/w/plain'] }))
    expect(fsTable(args)).toEqual({ ':root': 'read', ':project_roots': PROJECT_ROOTS, ':tmpdir': 'write', '/w/cw[1]d/hid': 'none', '/w/plain': 'read' })
  })

  it('no escaping is attempted', () => {
    const raw = flag(codexAdapter.buildArgs(input({ denyRead: ['/w/a[1]'], isolation: 'none' })).args, 'permissions.mffai.filesystem=')!
    expect(raw).toContain('"/w/a[1]"="none"')
  })

  it('a clean run reports nothing', () => {
    expect(codexAdapter.buildArgs(input()).unenforceable).toBeUndefined()
    expect(codexAdapter.profileGaps!(input())).toEqual([])
  })
})

describe('codex selfTest', () => {
  const st = (over = {}) => codexAdapter.selfTest!({ dir: '/tmp/st', secret: '/tmp/st-secret/key', flags: [], ...over })

  it('uses the same -c as a real run plus the secret, and stops at -- for the script', () => {
    const { args } = st({ denyRead: ['/h/.ssh'], flags: ['-c', 'x="y"'] })
    const real = codexAdapter.buildArgs(input({ denyRead: ['/h/.ssh', '/tmp/st-secret/key'] })).args
    const realFlags = real.slice(real.indexOf('-C') + 2, real.indexOf('-'))
    expect(args).toEqual(['sandbox', '-C', '/tmp/st', ...realFlags, '-c', 'x="y"', '-P', 'mffai', '--'])
    expect(fsTable(args)['/tmp/st-secret/key']).toBe('none')
  })

  const good = 'secret_read r=1\ncwd_write r=0\noutside_write r=1\ngit_write r=1\nnested_git_hook r=1\nnested_git_config r=1\ncodex_config_write r=1\nqoder_config_write r=1\ntmp_write r=0\nrule_write r=1\nrule_read r=1\nsecret_dir_read r=1\nnet_connect r=1\n'

  it('all rows as expected → nothing failed', () => {
    expect(st().parse(good)).toEqual([])
  })

  it('each row that went the wrong way is reported', () => {
    for (const row of ['secret_read', 'outside_write', 'git_write', 'nested_git_hook', 'nested_git_config', 'codex_config_write', 'qoder_config_write', 'rule_write', 'rule_read', 'secret_dir_read', 'net_connect']) {
      expect(st().parse(good.replace(`${row} r=1`, `${row} r=0`))).toEqual([row])
    }
    for (const row of ['cwd_write', 'tmp_write']) {
      expect(st().parse(good.replace(`${row} r=0`, `${row} r=1`))).toEqual([row])
    }
  })

  it('a missing marker fails, for every row; garbage fails every row', () => {
    for (const row of ['secret_read', 'cwd_write', 'outside_write', 'git_write', 'nested_git_hook', 'nested_git_config', 'codex_config_write', 'qoder_config_write', 'tmp_write', 'rule_write', 'rule_read', 'secret_dir_read', 'net_connect']) {
      const without = good.split('\n').filter(l => !l.startsWith(`${row} `)).join('\n')
      expect(st().parse(without)).toEqual([row])
    }
    expect(st().parse('').length).toBe(13)
    expect(st().parse('nope').length).toBe(13)
  })

  it('a second marker saying otherwise fails the row', () => {
    expect(st().parse(`${good}secret_read r=0\n`)).toEqual(['secret_read'])
    expect(st().parse(`secret_read r=0\n${good}`)).toEqual(['secret_read'])
  })

  it('takes the entries rule translation relies on, through the same map a real run uses', () => {
    const t = fsTable(st({ denyRead: ['/tmp/st/hidden', '/tmp/secdir'], readOnlyPaths: ['/tmp/st/ro'] }).args)
    expect(t).toMatchObject({ '/tmp/st/hidden': 'none', '/tmp/secdir': 'none', '/tmp/st/ro': 'read', ':project_roots': PROJECT_ROOTS })
  })

  describe('the subdirectory pass', () => {
    const sub = () => st({ subdir: true })
    it('has its own rows and keeps the same map as a real run', () => {
      expect(fsTable(sub().args)[':project_roots']).toEqual(PROJECT_ROOTS)
      expect(sub().parse('sub_cwd_write r=0\nparent_write r=1\nsibling_write r=1\n')).toEqual([])
      expect(sub().parse('sub_cwd_write r=0\nparent_write r=0\nsibling_write r=1\n')).toEqual(['parent_write'])
      expect(sub().parse('')).toEqual(['sub_cwd_write', 'parent_write', 'sibling_write'])
    })
  })

  describe('the read-only pass', () => {
    const ro = (over = {}) => st({ readOnly: true, ...over })
    const goodRo = 'ro_cwd_write r=1\nro_cwd_read r=0\n'

    it('has no :project_roots, like a real read-only run', () => {
      expect(fsTable(ro().args)[':project_roots']).toBeUndefined()
      expect(fsTable(ro().args)[':root']).toBe('read')
    })

    it('has its own rows', () => {
      expect(ro().parse(goodRo)).toEqual([])
      expect(ro().parse('ro_cwd_write r=0\nro_cwd_read r=0\n')).toEqual(['ro_cwd_write'])
      expect(ro().parse('ro_cwd_write r=1\nro_cwd_read r=1\n')).toEqual(['ro_cwd_read'])
      expect(ro().parse('ro_cwd_read r=0\n')).toEqual(['ro_cwd_write'])
      expect(ro().parse(good)).toEqual(['ro_cwd_write', 'ro_cwd_read'])
    })
  })
})

describe('codex parseLine', () => {
  const all = (lines: string[]): RunEvent[] => lines.flatMap(l => codexAdapter.parseLine(l))

  it('reads the recorded 0.154 lines', () => {
    expect(all(fixture('codex-exec-0.154.jsonl'))).toEqual([
      { kind: 'native', id: '01a1a028-9e2d-7d12-9367-026a34cb36f7' },
      { kind: 'progress', progress: 'think', text: 'Model metadata for `fake-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' },
      { kind: 'progress', progress: 'tool', text: '/bin/zsh -lc <clip>' },
      { kind: 'progress', progress: 'tool', text: '/bin/zsh -lc <clip>' },
      { kind: 'final', text: 'probe finished' },
      { kind: 'usage', usage: { input: 22, cached: 6, output: 10 } },
      { kind: 'completed' },
    ])
  })

  it('file_change gives files plus file', () => {
    expect(all(fixture('codex-file-change-derived.jsonl'))).toEqual([
      { kind: 'files', files: ['a.ts'] },
      { kind: 'progress', progress: 'file', text: 'a.ts' },
    ])
  })

  it('turn.failed and top-level error are errors, in each shape the CLI has used', () => {
    expect(codexAdapter.parseLine('{"type":"turn.failed","error":{"message":"boom"}}')).toEqual([{ kind: 'error', message: 'boom', fatal: true }])
    expect(codexAdapter.parseLine('{"type":"turn.failed","error":"boom"}')).toEqual([{ kind: 'error', message: 'boom', fatal: true }])
    expect(codexAdapter.parseLine('{"type":"error","message":"bad"}')).toEqual([{ kind: 'error', message: 'bad' }])
    expect(codexAdapter.parseLine('{"type":"error","error":{"message":"nested"}}')).toEqual([{ kind: 'error', message: 'nested' }])
    expect(codexAdapter.parseLine('{"type":"turn.failed"}')).toEqual([{ kind: 'error', message: 'turn.failed', fatal: true }])
  })

  it('bad or odd lines give nothing and never throw', () => {
    for (const l of ['', 'not json', '{', 'null', '3', '[]', '"x"', '{"type":"item.completed"}', '{"type":"item.completed","item":null}',
      '{"type":"item.completed","item":{"type":"agent_message","text":5}}', '{"type":"item.completed","item":{"type":"file_change","changes":"x"}}',
      '{"type":"item.completed","item":{"type":"command_execution"}}', '{"type":"thread.started","thread_id":5}', '{"type":"something.new"}']) {
      expect(codexAdapter.parseLine(l)).toEqual([])
    }
  })

  it('turn.completed without usable usage still completes', () => {
    expect(codexAdapter.parseLine('{"type":"turn.completed"}')).toEqual([{ kind: 'completed' }])
    expect(codexAdapter.parseLine('{"type":"turn.completed","usage":{"input_tokens":"x"}}')).toEqual([{ kind: 'completed' }])
    for (const bad of ['-1', '1.5', '1e999']) {
      expect(codexAdapter.parseLine(`{"type":"turn.completed","usage":{"input_tokens":${bad},"output_tokens":${bad}}}`)).toEqual([{ kind: 'completed' }])
    }
  })

  it('file_change skips entries with no path', () => {
    expect(codexAdapter.parseLine('{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"a"},{"x":1},{"path":5}]}}')).toEqual([
      { kind: 'files', files: ['a'] },
      { kind: 'progress', progress: 'file', text: 'a' },
    ])
  })
})

describe('codex classify', () => {
  const fold = (lines: string[], over: Partial<RunState> = {}): RunState =>
    lines.flatMap(l => codexAdapter.parseLine(l)).reduce(foldEvent, state(over))
  const recorded = fixture('codex-exec-0.154.jsonl')

  it('recorded lines → ok, the warning item ignored', () => {
    expect(codexAdapter.classify(fold(recorded))).toEqual({ status: 'ok' })
  })

  it('the same lines without turn.completed, exit 0 → no_result', () => {
    expect(codexAdapter.classify(fold(recorded.filter(l => !l.includes('turn.completed'))))).toEqual({ status: 'failed', reason: 'no_result' })
  })

  it('table', () => {
    const rows: [Partial<RunState>, object][] = [
      [{ completed: true, code: 1 }, { status: 'failed', reason: 'exit_nonzero' }],
      [{ code: 1 }, { status: 'failed', reason: 'exit_nonzero' }],
      [{ code: null, signal: 'SIGKILL' }, { status: 'failed', reason: 'exit_nonzero' }],
      [{ errors: [{ message: 'boom' }] }, { status: 'failed', reason: 'cli_error' }],
      [{ code: 1, errors: [{ message: 'boom' }] }, { status: 'failed', reason: 'cli_error' }],
      [{ code: 1, errors: [{ message: 'You hit your usage limit' }] }, { status: 'failed', reason: 'quota' }],
      [{ errors: [{ message: 'QUOTA exceeded' }] }, { status: 'failed', reason: 'quota' }],
      [{ errors: [{ message: '429 Rate Limit' }] }, { status: 'failed', reason: 'quota' }],
      [{ errors: [{ message: 'HTTP 401' }] }, { status: 'failed', reason: 'auth_missing' }],
      [{ errors: [{ message: 'Unauthorized' }] }, { status: 'failed', reason: 'auth_missing' }],
      [{ errors: [{ message: 'not logged in' }] }, { status: 'failed', reason: 'auth_missing' }],
      [{ errors: [{ message: 'x', auth: true }] }, { status: 'failed', reason: 'auth_missing' }],
      // 401 只算一个独立的数,不算文件名或行号的一部分
      [{ errors: [{ message: 'cannot open 14012.txt' }] }, { status: 'failed', reason: 'cli_error' }],
    ]
    for (const [s, want] of rows) expect(codexAdapter.classify(state(s))).toEqual(want)
  })

  it('the order is cancelled, timedOut, stalled, clean completion, auth, quota, then exit', () => {
    const everything = state({ completed: true, code: 1, errors: [{ message: 'quota' }, { message: 'x', auth: true }], cancelled: true, timedOut: true, stalled: true })
    expect(codexAdapter.classify(everything)).toEqual({ status: 'cancelled', reason: 'cancelled' })
    expect(codexAdapter.classify({ ...everything, cancelled: false })).toEqual({ status: 'timeout', reason: 'timeout' })
    expect(codexAdapter.classify({ ...everything, cancelled: false, timedOut: false })).toEqual({ status: 'stalled', reason: 'stalled' })
    expect(codexAdapter.classify({ ...everything, cancelled: false, timedOut: false, stalled: false })).toEqual({ status: 'failed', reason: 'auth_missing' })
    expect(codexAdapter.classify(state({ code: 1, errors: [{ message: 'quota' }] }))).toEqual({ status: 'failed', reason: 'quota' })
  })

  it('a clean completion is ok whatever was retried before it', () => {
    expect(codexAdapter.classify(fold(fixture('codex-retried-rate-limit-derived.jsonl')))).toEqual({ status: 'ok' })
    for (const message of ['Reconnecting... 2/5', 'Reconnecting... 1/1 (unexpected status 401 Unauthorized: x)', 'Reconnecting... 1/1 (rate limit exceeded: x)', 'usage limit', 'not logged in']) {
      const lines = [JSON.stringify({ type: 'error', message }), '{"type":"turn.completed"}']
      expect(codexAdapter.classify(fold(lines))).toEqual({ status: 'ok' })
    }
  })

  it('the same lines that never completed keep their reason', () => {
    const lines = fixture('codex-retried-rate-limit-derived.jsonl').filter(l => !l.includes('turn.completed'))
    expect(codexAdapter.classify(fold(lines))).toEqual({ status: 'failed', reason: 'quota' })
    expect(codexAdapter.classify(fold(['{"type":"error","message":"Reconnecting... 5/5"}']))).toEqual({ status: 'failed', reason: 'cli_error' })
    expect(codexAdapter.classify(fold(['{"type":"error","message":"unexpected status 401"}']))).toEqual({ status: 'failed', reason: 'auth_missing' })
    expect(codexAdapter.classify(fold(['{"type":"error","message":"rate limit"}', '{"type":"turn.completed"}'], { code: 1 }))).toEqual({ status: 'failed', reason: 'quota' })
  })

  it('a terminal 429 is quota', () => {
    expect(codexAdapter.classify(state({ code: 1, errors: [{ message: 'exceeded retry limit, last status: 429 Too Many Requests' }] }))).toEqual({ status: 'failed', reason: 'quota' })
    expect(codexAdapter.classify(state({ code: 1, errors: [{ message: 'too many requests' }] }))).toEqual({ status: 'failed', reason: 'quota' })
    expect(codexAdapter.classify(state({ code: 1, errors: [{ message: 'open 14290.txt' }] }))).toEqual({ status: 'failed', reason: 'cli_error' })
  })

  it('any turn.failed is a failure, in either order, even with turn.completed', () => {
    const failed = '{"type":"turn.failed","error":{"message":"boom"}}'
    const done = '{"type":"turn.completed"}'
    expect(codexAdapter.parseLine(failed)).toEqual([{ kind: 'error', message: 'boom', fatal: true }])
    expect(codexAdapter.classify(fold([failed, done]))).toEqual({ status: 'failed', reason: 'cli_error' })
    expect(codexAdapter.classify(fold([done, failed]))).toEqual({ status: 'failed', reason: 'cli_error' })
    expect(codexAdapter.classify(fold([done, '{"type":"turn.failed","error":{"message":"quota gone"}}']))).toEqual({ status: 'failed', reason: 'quota' })
  })
})

describe('foldEvent', () => {
  it('carries every flag classify needs', () => {
    const s = [
      { kind: 'error', message: 'a', auth: true },
      { kind: 'error', message: 'b', fatal: true },
      { kind: 'final', text: 'x' },
      { kind: 'completed' },
    ].reduce((acc, e) => foldEvent(acc, e as RunEvent), state())
    expect(s.errors).toEqual([{ message: 'a', auth: true }, { message: 'b', fatal: true }])
    expect(s.completed).toBe(true)
    expect(s.sawResult).toBe(true)
  })

  it('does not change its input', () => {
    const s = state()
    foldEvent(s, { kind: 'error', message: 'a' })
    foldEvent(s, { kind: 'completed' })
    expect(s).toEqual(state())
  })
})

describe('codex login and static fields', () => {
  it('parseLogin checks Not logged in before Logged in', () => {
    expect(codexAdapter.parseLogin('Not logged in')).toBe('missing')
    expect(codexAdapter.parseLogin('not logged in\n')).toBe('missing')
    expect(codexAdapter.parseLogin('Logged in using ChatGPT')).toBe('ok')
    expect(codexAdapter.parseLogin('')).toBe('unknown')
    expect(codexAdapter.parseLogin('error: unknown subcommand')).toBe('unknown')
  })

  it('static fields', () => {
    expect(codexAdapter).toMatchObject({ id: 'codex', bin: 'codex', toolName: 'delegate_codex', isolationKind: 'translate', passEnv: ['CODEX_HOME'], hosts: [], loginArgs: ['login', 'status'] })
    expect(codexAdapter.allowRead('/h', {})).toEqual([])
    expect(codexAdapter.allowWrite('/h', {})).toEqual([])
  })
})
