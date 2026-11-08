import { describe, it, expect } from 'vitest'
import { label, LABEL_KINDS } from './labels'
import { AccountStateSchema, ChannelStateSchema, ExecutorIsolationSchema, ExecutorRunStatusSchema, McpStateSchema, SandboxStatusSchema, SessionOriginSchema } from '@mffai/protocol/browser'

const CODES = {
  mcpState: McpStateSchema.options,
  channelState: ChannelStateSchema.options,
  runStatus: ExecutorRunStatusSchema.options,
  level: SandboxStatusSchema.shape.level.options,
  isolation: ExecutorIsolationSchema.options,
  accountState: AccountStateSchema.options,
  origin: SessionOriginSchema.options,
} as const

describe('labels', () => {
  it('covers exactly the seven kinds', () => {
    expect([...LABEL_KINDS].sort()).toEqual(Object.keys(CODES).sort())
  })

  for (const kind of LABEL_KINDS) {
    it(`${kind}: every protocol code has a Chinese label`, () => {
      for (const code of CODES[kind]) {
        const l = label(kind, code)
        expect(l, `${kind}:${code}`).not.toBe(code)
        expect(l).toMatch(/[一-鿿]/)
      }
    })
    it(`${kind}: an unknown code comes back verbatim, never throws`, () => {
      expect(label(kind, 'not_a_code_xyz')).toBe('not_a_code_xyz')
      expect(label(kind, '')).toBe('')
      expect(label(kind, '__proto__')).toBe('__proto__')
      expect(label(kind, 'toString')).toBe('toString')
    })
  }

  it('known values', () => {
    expect(label('level', 'full')).toBe('完整')
    expect(label('level', 'partial')).toBe('部分')
    expect(label('level', 'none')).toBe('未隔离')
    expect(label('runStatus', 'ok')).toBe('完成')
  })
})
