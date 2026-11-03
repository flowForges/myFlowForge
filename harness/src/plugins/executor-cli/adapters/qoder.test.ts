import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { qoderAdapter } from './qoder'
import { foldEvent, ModelSchema, WRITE_RUN_SUFFIX, type BuildInput, type RunState } from './types'

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
const NO_WEB = ['--disallowed-tools', 'WebFetch', '--disallowed-tools', 'WebSearch', '--disallowed-tools', 'ImageSearch', '--disallowed-tools', 'CronCreate', '--disallowed-tools', 'ImageGen']
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

  it('write modes disallow the listed tools', () => {
    for (const isolation of ['wrapped', 'none', 'own'] as const) {
      const { args } = qoderAdapter.buildArgs(input({ isolation }))
      const off = args.flatMap((a, i) => (a === '--disallowed-tools' ? [args[i + 1]] : []))
      expect(off).toEqual(['WebFetch', 'WebSearch', 'ImageSearch', 'CronCreate', 'ImageGen'])
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
      { kind: 'assistant', failed: true },
      { kind: 'final', text: 'Not logged in · Please run /login' },
      { kind: 'error', message: 'Not logged in · Please run /login' },
    ])
  })

  it('reads an explicit success', () => {
    expect(fixture('qoder-success-explicit-derived.jsonl').flatMap(l => qoderAdapter.parseLine(l))).toEqual([
      { kind: 'native', id: 's1' },
      { kind: 'final', text: 'done' },
      { kind: 'assistant', failed: false },
      { kind: 'final', text: 'done' },
      { kind: 'usage', usage: { input: 1, output: 1 } },
      { kind: 'completed' },
    ])
  })

  it('the app-derived success lines carry no is_error, and that is still a completion', () => {
    expect(fixture('qoder-success-derived.jsonl').flatMap(l => qoderAdapter.parseLine(l))).toEqual([
      { kind: 'final', text: '…' },
      { kind: 'progress', progress: 'tool', text: 'Bash: ls' },
      { kind: 'assistant', failed: false },
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
      { kind: 'assistant', failed: false },
    ])
  })

  it('authentication_failed with no text still reports auth', () => {
    expect(qoderAdapter.parseLine(assistant([], { error: 'authentication_failed' }))).toEqual([
      { kind: 'error', message: 'authentication_failed', auth: true },
      { kind: 'assistant', failed: true },
    ])
  })

  it('any other assistant.error is a plain error', () => {
    expect(qoderAdapter.parseLine(assistant([{ type: 'text', text: 'slow down' }], { error: 'rate_limit' }))).toEqual([
      { kind: 'final', text: 'slow down' },
      { kind: 'error', message: 'slow down' },
      { kind: 'assistant', failed: true },
    ])
    expect(qoderAdapter.parseLine(assistant([], { error: 'rate_limit' }))).toEqual([
      { kind: 'error', message: 'rate_limit' },
      { kind: 'assistant', failed: true },
    ])
    expect(qoderAdapter.parseLine(assistant([], { error: { code: 1 } }))).toEqual([
      { kind: 'error', message: 'assistant error' },
      { kind: 'assistant', failed: true },
    ])
    expect(qoderAdapter.parseLine(assistant([], { error: null }))).toEqual([{ kind: 'assistant', failed: false }])
  })

  it('a result that is not explicitly successful is an error or nothing, never a completion', () => {
    expect(qoderAdapter.parseLine('{"type":"result","is_error":true,"subtype":"error_during_execution"}')).toEqual([
      { kind: 'error', message: 'error_during_execution' },
    ])
    expect(qoderAdapter.parseLine('{"type":"result"}')).toEqual([])
    expect(qoderAdapter.parseLine('{"type":"result","subtype":"success"}')).toEqual([{ kind: 'completed' }])
    expect(qoderAdapter.parseLine('{"type":"result","subtype":"success","is_error":null}')).toEqual([{ kind: 'error', message: 'success' }])
    expect(qoderAdapter.parseLine('{"type":"result","is_error":false}')).toEqual([])
    expect(qoderAdapter.parseLine('{"type":"result","subtype":"error_max_turns","is_error":false}')).toEqual([{ kind: 'error', message: 'error_max_turns' }])
    expect(qoderAdapter.parseLine('{"type":"result","subtype":"success","is_error":"true"}')).toEqual([{ kind: 'error', message: 'success' }])
    expect(qoderAdapter.parseLine('{"type":"result","subtype":"success","is_error":0}')).toEqual([{ kind: 'error', message: 'success' }])
  })

  it('cached tokens are read when present; empty or nonsense usage gives no usage event', () => {
    const ok = '"subtype":"success","is_error":false'
    expect(qoderAdapter.parseLine(`{"type":"result",${ok},"usage":{"input_tokens":3,"output_tokens":4,"cache_read_input_tokens":2}}`)).toEqual([
      { kind: 'usage', usage: { input: 3, output: 4, cached: 2 } },
      { kind: 'completed' },
    ])
    expect(qoderAdapter.parseLine(`{"type":"result",${ok},"usage":{}}`)).toEqual([{ kind: 'completed' }])
    expect(qoderAdapter.parseLine(`{"type":"result",${ok},"usage":{"input_tokens":1e999}}`)).toEqual([{ kind: 'completed' }])
  })

  it('bad or odd lines give nothing and never throw', () => {
    for (const l of ['', 'nope', '{', 'null', '7', '[]', '{"type":"assistant"}', '{"type":"assistant","message":null}',
      '{"type":"system"}', '{"type":"system","subtype":"init"}', '{"type":"system","subtype":"other","session_id":"s"}', '{"type":"user"}']) {
      expect(qoderAdapter.parseLine(l)).toEqual([])
    }
    for (const l of ['{"type":"assistant","message":{"content":"x"}}', '{"type":"assistant","message":{"content":[null,5,{"type":"text"},{"type":"tool_use"},{"type":"thinking"}]}}']) {
      expect(qoderAdapter.parseLine(l)).toEqual([{ kind: 'assistant', failed: false }])
    }
  })
})

describe('qoder classify', () => {
  const fold = (lines: string[], over: Partial<RunState> = {}): RunState =>
    lines.flatMap(l => qoderAdapter.parseLine(l)).reduce(foldEvent, state(over))
  const SUCCESS = '{"type":"result","subtype":"success","is_error":false,"result":"done"}'
  const clean = '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}'
  const erred = (e: string) => JSON.stringify({ type: 'assistant', message: { content: [] }, error: e })

  it('recorded lines → auth_missing, even though subtype is success', () => {
    expect(qoderAdapter.classify(fold(fixture('qoder-not-logged-in-1.0.29.jsonl'), { code: 1 }))).toEqual({ status: 'failed', reason: 'auth_missing' })
    expect(qoderAdapter.classify(fold(fixture('qoder-not-logged-in-1.0.29.jsonl'), { code: 0 }))).toEqual({ status: 'failed', reason: 'auth_missing' })
  })

  it('an explicit success → ok', () => {
    expect(qoderAdapter.classify(fold(fixture('qoder-success-explicit-derived.jsonl')))).toEqual({ status: 'ok' })
    expect(qoderAdapter.classify(fold([SUCCESS]))).toEqual({ status: 'ok' })
  })

  it('is_error may be absent: the app-derived lines are ok', () => {
    expect(qoderAdapter.classify(fold(fixture('qoder-success-derived.jsonl')))).toEqual({ status: 'ok' })
    expect(qoderAdapter.classify(fold(['{"type":"result","subtype":"success"}']))).toEqual({ status: 'ok' })
  })

  it.each([
    ['{"type":"result"}', 'no_result'],
    ['{"type":"result","is_error":false}', 'no_result'],
    ['{"type":"result","subtype":"success","is_error":"true"}', 'cli_error'],
    ['{"type":"result","subtype":"success","is_error":1}', 'cli_error'],
    ['{"type":"result","subtype":"success","is_error":0}', 'cli_error'],
    ['{"type":"result","subtype":"success","is_error":null}', 'cli_error'],
    ['{"type":"result","subtype":"success","is_error":true,"result":"something broke"}', 'cli_error'],
    ['{"type":"result","subtype":"error_during_execution"}', 'cli_error'],
    ['{"type":"result","subtype":"error_max_turns","is_error":false}', 'cli_error'],
  ])('%s → %s with exit 0', (line, reason) => {
    expect(qoderAdapter.classify(fold([line]))).toEqual({ status: 'failed', reason })
  })

  it('an error on the final assistant message beats a clean result', () => {
    expect(qoderAdapter.classify(fold([erred('overloaded'), SUCCESS]))).toEqual({ status: 'failed', reason: 'cli_error' })
    expect(qoderAdapter.classify(fold([SUCCESS, erred('overloaded')]))).toEqual({ status: 'failed', reason: 'cli_error' })
    expect(qoderAdapter.classify(fold([erred('overloaded'), '{"type":"result","subtype":"success"}']))).toEqual({ status: 'failed', reason: 'cli_error' })
    expect(qoderAdapter.classify(fold([erred('rate_limit'), SUCCESS]))).toEqual({ status: 'failed', reason: 'cli_error' })
    expect(qoderAdapter.classify(fold([clean, erred('authentication_failed'), SUCCESS]))).toEqual({ status: 'failed', reason: 'auth_missing' })
  })

  it('an error on an earlier message, with a clean message after it, is ok', () => {
    expect(qoderAdapter.classify(fold([erred('overloaded'), clean, SUCCESS]))).toEqual({ status: 'ok' })
  })

  it('a line with no message does not clear an earlier error', () => {
    expect(qoderAdapter.classify(fold([erred('overloaded'), '{"type":"assistant"}', SUCCESS]))).toEqual({ status: 'failed', reason: 'cli_error' })
  })

  it('table', () => {
    const rows: [Partial<RunState>, object][] = [
      [{ completed: true, errors: [{ message: 'boom' }], assistantError: true }, { status: 'failed', reason: 'cli_error' }],
      [{ completed: true, code: 2 }, { status: 'failed', reason: 'exit_nonzero' }],
      [{}, { status: 'failed', reason: 'no_result' }],
      [{ sawResult: true }, { status: 'failed', reason: 'no_result' }],
      [{ code: 1 }, { status: 'failed', reason: 'exit_nonzero' }],
      [{ errors: [{ message: 'rate limit' }] }, { status: 'failed', reason: 'quota' }],
      [{ completed: true, cancelled: true }, { status: 'cancelled', reason: 'cancelled' }],
      [{ completed: true, timedOut: true }, { status: 'timeout', reason: 'timeout' }],
      [{ completed: true, stalled: true }, { status: 'stalled', reason: 'stalled' }],
    ]
    for (const [s, want] of rows) expect(qoderAdapter.classify(state(s))).toEqual(want)
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
