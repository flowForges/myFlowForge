import { describe, it, expect } from 'vitest'
import { memoryUnsupported } from './unavailable'
import { callError } from '../test/fakeForge'

describe('memoryUnsupported', () => {
  it('a -32601 is unsupported', () => {
    expect(memoryUnsupported(callError(-32601))).toBe(true)
  })

  it('a -32603 "memory is unavailable" is unsupported', () => {
    expect(memoryUnsupported(callError(-32603, 'memory is unavailable'))).toBe(true)
  })

  it('a -32603 with a different message is not', () => {
    expect(memoryUnsupported(callError(-32603, 'boom'))).toBe(false)
  })

  it('a different code is not', () => {
    expect(memoryUnsupported(callError(-32602, 'full'))).toBe(false)
    expect(memoryUnsupported(callError(-32010, 'timeout'))).toBe(false)
  })
})
