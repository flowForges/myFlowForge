import { describe, it, expect } from 'vitest'
import { buildAgentEnv } from './env'

describe('buildAgentEnv', () => {
  it('injects proxy vars and merges provider overrides', () => {
    const env = buildAgentEnv({ proxy: 'http://127.0.0.1:7897', overrides: { FOO: 'bar' } })
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7897')
    expect(env.ALL_PROXY).toBe('http://127.0.0.1:7897')
    expect(env.NO_PROXY).toContain('localhost')
    expect(env.FOO).toBe('bar')
  })
  it('omits proxy vars when proxy empty', () => {
    const env = buildAgentEnv({ proxy: '' })
    expect(env.HTTPS_PROXY).toBeUndefined()
  })
})
