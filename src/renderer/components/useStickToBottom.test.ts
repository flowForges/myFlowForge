import { describe, it, expect } from 'vitest'
import { isNearBottom } from './useStickToBottom'

describe('isNearBottom', () => {
  it('is true when scrolled to the exact bottom', () => {
    expect(isNearBottom({ scrollTop: 760, scrollHeight: 1000, clientHeight: 240 })).toBe(true)
  })

  it('is true within the default slack threshold of the bottom', () => {
    // 1000 - 740 - 240 = 20px from bottom → still "at bottom"
    expect(isNearBottom({ scrollTop: 740, scrollHeight: 1000, clientHeight: 240 })).toBe(true)
  })

  it('is false when scrolled well above the bottom', () => {
    expect(isNearBottom({ scrollTop: 200, scrollHeight: 1000, clientHeight: 240 })).toBe(false)
  })

  it('honors a custom threshold', () => {
    // 120px from bottom: within a 150 threshold, outside the default (~32)
    const m = { scrollTop: 640, scrollHeight: 1000, clientHeight: 240 }
    expect(isNearBottom(m, 150)).toBe(true)
    expect(isNearBottom(m)).toBe(false)
  })

  it('treats a non-scrollable (fully visible) container as at bottom', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 240 })).toBe(true)
  })
})
