import { describe, it, expect } from 'vitest'
import { parseServer, dangerousEnvName, type ServerCtx } from './mcpConfig'
import type { ConfigKey } from './types'

const cfg = (k: string, sensitive: boolean): ConfigKey => ({ key: k, title: k, sensitive, required: true, type: 'string', from: 'manifest' })
const ctx: ServerCtx = { format: 'claude', config: new Map([['tok', cfg('tok', true)], ['mode', cfg('mode', false)]]), home: '/Users/me' }
const p = (raw: unknown, name = 's', c: ServerCtx = ctx) => parseServer(name, raw, c)

describe('parseServer problems', () => {
  it('a clean server', () => {
    const s = p({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/s.js', '--mode=${user_config.mode}'], env: { A: '1' } })
    expect(s.problems).toEqual([])
    expect(s.args).toEqual(['${PLUGIN_ROOT}/s.js', '--mode=${user_config.mode}'])
    expect(s.declared).toBeNull()
    expect(s.env).toEqual([{ name: 'A', source: 'literal', required: false, value: '1' }])
  })

  const rows: [string, unknown, string][] = [
    ['${TOKEN} in args', { command: 'node', args: ['--t=${TOKEN}'] }, 'arg_env_ref'],
    ['sensitive config in args', { command: 'node', args: ['${user_config.tok}'] }, 'arg_env_ref'],
    ['undeclared config in args', { command: 'node', args: ['${user_config.zzz}'] }, 'arg_env_ref'],
    ['config in command', { command: '${user_config.mode}' }, 'bad_command'],
    ['var in command', { command: '${TOKEN}/x' }, 'bad_command'],
    ['NODE_OPTIONS', { command: 'node', env: { NODE_OPTIONS: '--require x' } }, 'dangerous_env'],
    ['node_options', { command: 'node', env: { node_options: 'x' } }, 'dangerous_env'],
    ['DYLD_INSERT_LIBRARIES', { command: 'node', env: { DYLD_INSERT_LIBRARIES: 'x' } }, 'dangerous_env'],
    ['GCONV_PATH', { command: 'node', env: { GCONV_PATH: 'x' } }, 'dangerous_env'],
    ['PATH', { command: 'node', env: { PATH: 'x' } }, 'dangerous_env'],
    ['HTTP_PROXY', { command: 'node', env: { HTTP_PROXY: 'x' } }, 'dangerous_env'],
    ['http_proxy', { command: 'node', env: { http_proxy: 'x' } }, 'dangerous_env'],
    ['GIT_SSH_COMMAND', { command: 'node', env: { GIT_SSH_COMMAND: 'x' } }, 'dangerous_env'],
    ['PYTHONPATH', { command: 'node', env: { PYTHONPATH: 'x' } }, 'dangerous_env'],
    ['MFFAI_TOKEN', { command: 'node', env: { MFFAI_TOKEN: 'x' } }, 'dangerous_env'],
    ['bad env name', { command: 'node', env: { 'A-B': 'x' } }, 'dangerous_env'],
    ['NUL in value', { command: 'node', env: { A: 'x\0y' } }, 'dangerous_env'],
    ['non-string value', { command: 'node', env: { A: 1 } }, 'dangerous_env'],
    ['docker', { command: 'docker', args: ['run'] }, 'runtime_unsupported'],
    ['podman path', { command: '/usr/bin/podman' }, 'runtime_unsupported'],
    ['command with args in it', { command: 'node server.js' }, 'bad_command'],
    ['absolute under home', { command: '/Users/me/Documents/a/b' }, 'bad_command'],
    ['tilde', { command: '~/x' }, 'bad_command'],
    ['no command', { args: [] }, 'bad_command'],
    ['args not a list', { command: 'node', args: 'x' }, 'bad_command'],
    ['escapes the root', { command: '../x' }, 'command_outside_root'],
    ['escapes the root through the root symbol', { command: '${CLAUDE_PLUGIN_ROOT}/../x' }, 'command_outside_root'],
    ['data dir as command', { command: '${CLAUDE_PLUGIN_DATA}/x' }, 'bad_command'],
    ['not an object', 'node', 'bad_command'],
  ]
  it.each(rows)('%s', (_n, raw, code) => expect(p(raw).problems).toContain(code))

  it('relative-in-root, plain names and system absolute paths are fine', () => {
    for (const command of ['./bin/x', 'bin/x', '${CLAUDE_PLUGIN_ROOT}/bin/x', 'node', 'python3', '/usr/bin/env', '/opt/homebrew/bin/node'])
      expect(p({ command }).problems, command).toEqual([])
  })

  it('names: shape and prototype names', () => {
    for (const n of ['__proto__', 'constructor', 'prototype', 'a b', 'a/b', '', 'x'.repeat(65)]) expect(p({ command: 'node' }, n).problems, n).toContain('name_invalid')
    expect(p({ command: 'node' }, 'ok_name-1').problems).toEqual([])
  })

  it('env sources', () => {
    const s = p({ command: 'node', env: { A: 'lit', B: '${user_config.mode}', C: '${user_config.tok}', D: '${ANTHROPIC_API_KEY}', E: 'Bearer ${user_config.mode}-${X}', F: '${CLAUDE_PLUGIN_DATA}/db' } })
    const by = Object.fromEntries(s.env.map(e => [e.name, e]))
    expect(by.A).toMatchObject({ source: 'literal', value: 'lit' })
    expect(by.B).toMatchObject({ source: 'config', required: true })
    expect(by.C.source).toBe('secret')
    expect(by.D).toMatchObject({ source: 'secret', required: true })
    expect(by.D.value).toBeUndefined()
    expect(by.E.source).toBe('secret')
    expect(by.F).toMatchObject({ source: 'literal', value: '${PLUGIN_DATA}/db' })
    expect(s.configRefs).toEqual(['ANTHROPIC_API_KEY', 'X', 'mode', 'tok'])
  })

  it('env is sorted so key order cannot change a hash', () => {
    const a = p({ command: 'node', env: { B: '1', A: '2' } })
    const b = p({ command: 'node', env: { A: '2', B: '1' } })
    expect(a).toEqual(b)
  })

  it('fetchesAtRuntime and suggested hosts', () => {
    expect(p({ command: 'npx', args: ['-y', 'pkg'] })).toMatchObject({ fetchesAtRuntime: true, suggestedHosts: ['registry.npmjs.org'] })
    expect(p({ command: 'bunx', args: ['pkg'] }).fetchesAtRuntime).toBe(true)
    expect(p({ command: 'uvx', args: ['pkg'] })).toMatchObject({ fetchesAtRuntime: true, suggestedHosts: ['pypi.org', 'files.pythonhosted.org'] })
    expect(p({ command: 'pnpm', args: ['dlx', 'pkg'] }).fetchesAtRuntime).toBe(true)
    expect(p({ command: 'bun', args: ['x', 'pkg'] }).fetchesAtRuntime).toBe(true)
    expect(p({ command: 'bun', args: ['run', 'x'] }).fetchesAtRuntime).toBe(false)
    expect(p({ command: 'node' }).suggestedHosts).toEqual([])
  })

  it('remote transports are marked, not problems', () => {
    expect(p({ type: 'http', url: 'https://x.example.com/mcp' }).remote).toEqual({ type: 'http', url: 'https://x.example.com/mcp' })
    expect(p({ type: 'sse', url: 'u' }).remote?.type).toBe('sse')
    expect(p({ url: 'https://x' }).remote?.type).toBe('http')
    expect(p({ type: 'stdio', command: 'node' }).remote).toBeUndefined()
  })

  it('native declared permissions', () => {
    const n: ServerCtx = { ...ctx, format: 'native' }
    expect(p({ command: 'node' }, 's', n).declared).toEqual({ network: [], cwd: 'read' })
    expect(p({ command: 'node', permissions: { network: ['b.example.com', 'a.example.com'], cwd: 'none' } }, 's', n).declared).toEqual({ network: ['a.example.com', 'b.example.com'], cwd: 'none' })
  })

  it('dangerousEnvName', () => {
    expect(dangerousEnvName('API_KEY')).toBe(false)
    expect(dangerousEnvName('LDAP_URL')).toBe(false)
    expect(dangerousEnvName('LD_PRELOAD')).toBe(true)
  })
})

describe('the template of a non-literal env value', () => {
  it('is kept for the host, symbolic, only where there is no literal value', () => {
    const s = p({ command: 'node', env: { A: 'Bearer ${user_config.tok}', B: '${CLAUDE_PLUGIN_ROOT}/x', C: '${TOKEN}', D: '${user_config.mode}-${MFF_PLUGIN_DATA}' } })
    const by = Object.fromEntries(s.env.map(e => [e.name, e]))
    expect(by.A).toMatchObject({ source: 'secret', template: 'Bearer ${user_config.tok}' })
    expect(by.A.value).toBeUndefined()
    expect(by.B).toMatchObject({ source: 'literal', value: '${PLUGIN_ROOT}/x' })
    expect(by.B.template).toBeUndefined()
    expect(by.C).toMatchObject({ source: 'secret', template: '${TOKEN}' })
    expect(by.D).toMatchObject({ source: 'config', template: '${user_config.mode}-${PLUGIN_DATA}' })
  })
})
