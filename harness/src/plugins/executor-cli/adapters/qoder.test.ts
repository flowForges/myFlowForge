import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { qoderAdapter } from './qoder'
import { ModelSchema, WRITE_RUN_SUFFIX, type BuildInput, type RunState } from './types'

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../test/fixtures/executors/${name}`, import.meta.url)), 'utf8').split('\n').filter(Boolean)

const input = (over: Partial<BuildInput> = {}): BuildInput => ({
  prompt: 'do it',
  cwd: '/work/repo',
  readOnly: false,
  isolation: 'wrapped',
  denyRead: [],
  readOnlyPaths: [],
  network: false,
  ...over,
})
const state = (over: Partial<RunState> = {}): RunState => ({
  code: 0, signal: null, completed: false, sawResult: false, errors: [], timedOut: false, stalled: false, cancelled: false, ...over,
})

const BASE = ['-p', '--output-format', 'stream-json', '--cwd', '/work/repo', '--strict-mcp-config', '--setting-sources', 'user']
const NO_WEB = ['--disallowed-tools', 'WebFetch', '--disallowed-tools', 'WebSearch', '--disallowed-tools', 'ImageSearch', '--disallowed-tools', 'CronCreate']
const SKIP = '--dangerously-skip-permissions'
const modes = [
  { readOnly: false, isolation: 'wrapped' as const },
  { readOnly: false, isolation: 'none' as const },
  { readOnly: false, isolation: 'own' as const },
  { readOnly: true, isolation: 'wrapped' as const },
  { readOnly: true, isolation: 'none' as const },
]

describe('qoder buildArgs', () => {
  it('wrapped, none and read-only match spec §8.2 exactly', () => {
    expect(qoderAdapter.buildArgs(input()).args).toEqual([...BASE, '--permission-mode', 'bypass_permissions', SKIP, ...NO_WEB])
    expect(qoderAdapter.buildArgs(input({ isolation: 'none' })).args).toEqual([...BASE, '--permission-mode', 'accept_edits', ...NO_WEB])
    expect(qoderAdapter.buildArgs(input({ readOnly: true })).args).toEqual([
      ...BASE, '--permission-mode', 'dont_ask', '--tools', 'Read', 'Grep', 'Glob',
      '--disallowed-tools', 'Edit', '--disallowed-tools', 'Write', '--disallowed-tools', 'Bash',
    ])
    expect(qoderAdapter.buildArgs(input({ model: 'auto' })).args.slice(-2)).toEqual(['-m', 'auto'])
  })

  it('the skip flag appears only for a wrapped write run', () => {
    for (const m of modes) {
      const has = qoderAdapter.buildArgs(input(m)).args.includes(SKIP)
      expect(has).toBe(!m.readOnly && m.isolation === 'wrapped')
      if (!has) expect(qoderAdapter.buildArgs(input(m)).args).not.toContain('bypass_permissions')
    }
  })

  it('the prompt reaches stdin and never argv, even when it is the skip flag', () => {
    for (const m of modes) {
      for (const prompt of [SKIP, '--permission-mode bypass_permissions', 'plain-marker-text']) {
        const { args, stdin } = qoderAdapter.buildArgs(input({ ...m, prompt }))
        expect(stdin!.startsWith(prompt)).toBe(true)
        if (prompt !== SKIP) expect(args.join('\0')).not.toContain(prompt)
        expect(args.includes(SKIP)).toBe(!m.readOnly && m.isolation === 'wrapped')
      }
    }
    expect(qoderAdapter.buildArgs(input({ isolation: 'none', prompt: SKIP })).args).not.toContain(SKIP)
    expect(qoderAdapter.buildArgs(input({ readOnly: true, prompt: SKIP })).args).not.toContain(SKIP)
  })

  it('nothing positional follows the variadic --tools', () => {
    const { args } = qoderAdapter.buildArgs(input({ readOnly: true, model: 'auto', prompt: 'Sneaky' }))
    const after = args.slice(args.indexOf('--tools') + 1)
    expect(after.slice(0, 4)).toEqual(['Read', 'Grep', 'Glob', '--disallowed-tools'])
    // -p 不带值:紧跟着的是下一个旗标,没有查询参数
    expect(args[0]).toBe('-p')
    expect(args[1]).toBe('--output-format')
    expect(args).not.toContain('Sneaky')
  })

  it('--setting-sources user and --strict-mcp-config are always there', () => {
    for (const m of modes) {
      const { args } = qoderAdapter.buildArgs(input(m))
      expect(args[args.indexOf('--setting-sources') + 1]).toBe('user')
      expect(args).toContain('--strict-mcp-config')
    }
  })

  it('write modes disallow the four tools', () => {
    for (const isolation of ['wrapped', 'none', 'own'] as const) {
      const { args } = qoderAdapter.buildArgs(input({ isolation }))
      const off = args.flatMap((a, i) => (a === '--disallowed-tools' ? [args[i + 1]] : []))
      expect(off).toEqual(['WebFetch', 'WebSearch', 'ImageSearch', 'CronCreate'])
    }
  })

  it('a model of --foo is rejected by the schema and never reaches argv', () => {
    for (const model of ['--foo', '-p', '', 'a b', 'a\nb', 'x'.repeat(101), SKIP]) {
      expect(ModelSchema.safeParse(model).success).toBe(false)
      expect(() => qoderAdapter.buildArgs(input({ model }))).toThrow()
    }
    for (const model of ['auto', 'gpt-5.1', 'vendor/model:tag', 'A.b']) expect(ModelSchema.safeParse(model).success).toBe(true)
  })

  it('a cwd that is not absolute is refused', () => {
    expect(() => qoderAdapter.buildArgs(input({ cwd: '--tools' }))).toThrow()
  })

  it('stdin is redacted; only write runs get the suffix', () => {
    const key = 'sk-abcdefghijklmnopqrstuvwxyz'
    const rw = qoderAdapter.buildArgs(input({ prompt: key }))
    expect(rw.stdin).toBe(`***\n\n${WRITE_RUN_SUFFIX}`)
    expect(rw.args.join(' ')).not.toContain(key)
    expect(qoderAdapter.buildArgs(input({ prompt: key, readOnly: true })).stdin).toBe('***')
  })
})

describe('qoder paths', () => {
  it('allowWrite is the six subdirectories, never ~/.qoder or its code', () => {
    const w = qoderAdapter.allowWrite('/h', {})
    expect(w).toEqual(['/h/.qoder/.auth', '/h/.qoder/logs', '/h/.qoder/projects', '/h/.qoder/tmp', '/h/.qoder/cache', '/h/.qoder/.cache'])
    for (const bad of ['/h/.qoder', '/h/.qoder/bin', '/h/.qoder/settings.json', '/h/.qoder/external-commands']) expect(w).not.toContain(bad)
  })

  it('allowRead is .auth only', () => {
    expect(qoderAdapter.allowRead('/h', {})).toEqual(['/h/.qoder/.auth'])
  })

  it('static fields', () => {
    expect(qoderAdapter).toMatchObject({
      id: 'qoder', bin: 'qodercli', toolName: 'delegate_qoder', isolationKind: 'wrap', passEnv: [],
      hosts: ['*.qoder.sh', '*.qoder.com', '*.qoder.com.cn', '*.qoder.ai'], loginArgs: ['status', '-o', 'json'],
    })
    expect(qoderAdapter.selfTest).toBeUndefined()
  })
})

describe('qoder parseLine', () => {
  it('reads the recorded not-logged-in lines', () => {
    expect(fixture('qoder-not-logged-in-1.0.29.jsonl').flatMap(l => qoderAdapter.parseLine(l))).toEqual([
      { kind: 'native', id: 's1' },
      { kind: 'final', text: 'Not logged in · Please run /login' },
      { kind: 'error', message: 'Not logged in · Please run /login', auth: true },
      { kind: 'final', text: 'Not logged in · Please run /login' },
      { kind: 'error', message: 'Not logged in · Please run /login' },
      { kind: 'completed' },
    ])
  })

  it('reads the success lines (derived from the app tests)', () => {
    expect(fixture('qoder-success-derived.jsonl').flatMap(l => qoderAdapter.parseLine(l))).toEqual([
      { kind: 'final', text: '…' },
      { kind: 'progress', progress: 'tool', text: 'Bash: ls' },
      { kind: 'final', text: '…' },
      { kind: 'usage', usage: { input: 1, output: 1 } },
      { kind: 'completed' },
    ])
  })

  const assistant = (content: unknown[], extra = {}) => JSON.stringify({ type: 'assistant', message: { content }, ...extra })

  it('Edit and Write with file_path also give files; thinking gives think', () => {
    expect(qoderAdapter.parseLine(assistant([
      { type: 'thinking', thinking: 'hmm' },
      { type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } },
      { type: 'tool_use', name: 'Write', input: { file_path: 'b.ts' } },
      { type: 'tool_use', name: 'Read', input: { file_path: 'c.ts' } },
      { type: 'tool_use', name: 'Edit', input: {} },
    ]))).toEqual([
      { kind: 'progress', progress: 'think', text: 'hmm' },
      { kind: 'progress', progress: 'tool', text: 'Edit: a.ts' },
      { kind: 'files', files: ['a.ts'] },
      { kind: 'progress', progress: 'tool', text: 'Write: b.ts' },
      { kind: 'files', files: ['b.ts'] },
      { kind: 'progress', progress: 'tool', text: 'Read: c.ts' },
      { kind: 'progress', progress: 'tool', text: 'Edit' },
    ])
  })

  it('authentication_failed with no text still reports auth', () => {
    expect(qoderAdapter.parseLine(assistant([], { error: 'authentication_failed' }))).toEqual([
      { kind: 'error', message: 'authentication_failed', auth: true },
    ])
  })

  it('a result with is_error and no text is still an error', () => {
    expect(qoderAdapter.parseLine('{"type":"result","is_error":true,"subtype":"error_during_execution"}')).toEqual([
      { kind: 'error', message: 'error_during_execution' },
      { kind: 'completed' },
    ])
  })

  it('cached tokens are read when present; empty usage gives no usage event', () => {
    expect(qoderAdapter.parseLine('{"type":"result","usage":{"input_tokens":3,"output_tokens":4,"cache_read_input_tokens":2}}')).toEqual([
      { kind: 'usage', usage: { input: 3, output: 4, cached: 2 } },
      { kind: 'completed' },
    ])
    expect(qoderAdapter.parseLine('{"type":"result","usage":{}}')).toEqual([{ kind: 'completed' }])
  })

  it('bad or odd lines give nothing and never throw', () => {
    for (const l of ['', 'nope', '{', 'null', '7', '[]', '{"type":"assistant"}', '{"type":"assistant","message":null}',
      '{"type":"assistant","message":{"content":"x"}}', '{"type":"assistant","message":{"content":[null,5,{"type":"text"},{"type":"tool_use"},{"type":"thinking"}]}}',
      '{"type":"system"}', '{"type":"system","subtype":"init"}', '{"type":"system","subtype":"other","session_id":"s"}', '{"type":"user"}']) {
      expect(qoderAdapter.parseLine(l)).toEqual([])
    }
  })
})

describe('qoder classify', () => {
  const fold = (lines: string[], over: Partial<RunState> = {}): RunState => {
    const s = state(over)
    for (const e of lines.flatMap(l => qoderAdapter.parseLine(l))) {
      if (e.kind === 'completed') { s.completed = true; s.sawResult = true }
      if (e.kind === 'error') s.errors.push({ message: e.message, auth: e.auth })
    }
    return s
  }

  it('recorded lines → auth_missing, even though subtype is success', () => {
    expect(qoderAdapter.classify(fold(fixture('qoder-not-logged-in-1.0.29.jsonl'), { code: 1 }))).toEqual({ status: 'failed', reason: 'auth_missing' })
    expect(qoderAdapter.classify(fold(fixture('qoder-not-logged-in-1.0.29.jsonl'), { code: 0 }))).toEqual({ status: 'failed', reason: 'auth_missing' })
  })

  it('success lines → ok', () => {
    expect(qoderAdapter.classify(fold(fixture('qoder-success-derived.jsonl')))).toEqual({ status: 'ok' })
  })

  it('table', () => {
    const rows: [Partial<RunState>, object][] = [
      [{ sawResult: true, errors: [{ message: 'boom' }] }, { status: 'failed', reason: 'cli_error' }],
      [{ sawResult: true, code: 2 }, { status: 'failed', reason: 'exit_nonzero' }],
      [{}, { status: 'failed', reason: 'no_result' }],
      [{ code: 1 }, { status: 'failed', reason: 'exit_nonzero' }],
      [{ sawResult: true, errors: [{ message: 'rate limit' }] }, { status: 'failed', reason: 'quota' }],
      [{ sawResult: true, cancelled: true }, { status: 'cancelled', reason: 'cancelled' }],
      [{ sawResult: true, timedOut: true }, { status: 'timeout', reason: 'timeout' }],
      [{ sawResult: true, stalled: true }, { status: 'stalled', reason: 'stalled' }],
    ]
    for (const [s, want] of rows) expect(qoderAdapter.classify(state(s))).toEqual(want)
  })

  it('an is_error result is a failure with a clean exit and no auth text', () => {
    expect(qoderAdapter.classify(fold(['{"type":"result","subtype":"success","is_error":true,"result":"something broke"}']))).toEqual({ status: 'failed', reason: 'cli_error' })
  })
})

describe('qoder parseLogin', () => {
  it('reads logged_in and nothing else', () => {
    expect(qoderAdapter.parseLogin('{"logged_in":false}')).toBe('missing')
    expect(qoderAdapter.parseLogin('{"logged_in":true}')).toBe('ok')
    expect(qoderAdapter.parseLogin('{"logged_in":false,"x":1}\n')).toBe('missing')
    for (const out of ['', 'garbage', '{', 'null', '[]', 'true', '{"logged_in":"true"}', '{"logged_in":1}', '{}', 'Logged in']) {
      expect(qoderAdapter.parseLogin(out)).toBe('unknown')
    }
  })
})
