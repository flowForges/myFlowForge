import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, buildGitEnv } from './gitRunner'

describe('gitRunner', () => {
  it('runs git in a cwd and returns stdout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-'))
    await git(['init'], { cwd: dir })
    const out = await git(['rev-parse', '--is-inside-work-tree'], { cwd: dir })
    expect(out.trim()).toBe('true')
    rmSync(dir, { recursive: true, force: true })
  })
  it('accepts an AbortSignal without hitting execa\'s signal→cancelSignal rename TypeError', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-'))
    await git(['init'], { cwd: dir })
    const ctrl = new AbortController()
    // A live (non-aborted) signal reaches execa. On execa v9 the old `signal` option throws
    // "the signal option has been renamed to cancelSignal instead"; the mapped option must not.
    const out = await git(['rev-parse', '--is-inside-work-tree'], { cwd: dir, signal: ctrl.signal })
    expect(out.trim()).toBe('true')
    rmSync(dir, { recursive: true, force: true })
  })
  it('injects proxy env vars when proxy provided', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-'))
    await git(['init'], { cwd: dir })
    const { buildGitEnv } = await import('./gitRunner')
    const env = buildGitEnv('http://127.0.0.1:7897')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7897')
    expect(env.NO_PROXY).toContain('127.0.0.1')
    expect(buildGitEnv('').HTTPS_PROXY).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })
  // ★「终端代理留空 = 直连」必须是字面的。app 继承整个启动环境,上面很可能已经带着一个用户
  // 在设置里看不见、也清不掉的 HTTP(S)_PROXY。agents/env.ts 的 buildAgentEnv 为此显式删掉它们
  // (注释里写了 403 footgun 的来历),但 git 这边一直没有 —— 于是清空设置后 agent 直连了,
  // git clone/fetch 还在走那个看不见的代理。上面那条断言之所以一直绿,只是因为跑测试的环境恰好干净。
  it('★ 代理留空时,连【继承来的】代理也要剥掉 —— 否则 git 会走一个用户看不见的代理', () => {
    const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
    const prev: Record<string, string | undefined> = {}
    for (const k of keys) { prev[k] = process.env[k]; process.env[k] = 'http://inherited.example:9999' }
    try {
      const env = buildGitEnv('')
      for (const k of keys) expect(env[k], k).toBeUndefined()
    } finally {
      for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k] }
    }
  })

  it('sets GIT_SSH_COMMAND with accept-new so first-time SSH hosts self-trust (non-interactive clone)', () => {
    const env = buildGitEnv('')
    expect(env.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=accept-new')
  })
  it('preserves a user-provided GIT_SSH_COMMAND instead of overriding it', () => {
    const prev = process.env.GIT_SSH_COMMAND
    process.env.GIT_SSH_COMMAND = 'ssh -i /custom/key'
    try {
      expect(buildGitEnv('').GIT_SSH_COMMAND).toBe('ssh -i /custom/key')
    } finally {
      if (prev === undefined) delete process.env.GIT_SSH_COMMAND
      else process.env.GIT_SSH_COMMAND = prev
    }
  })
})
