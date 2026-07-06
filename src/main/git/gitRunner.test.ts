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
