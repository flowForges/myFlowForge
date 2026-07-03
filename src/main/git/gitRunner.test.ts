import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from './gitRunner'

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
})
