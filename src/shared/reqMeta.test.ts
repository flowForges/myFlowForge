import { describe, it, expect } from 'vitest'
import { reqKindLabel, REQ_KIND_ICON } from './reqMeta'

describe('reqMeta', () => {
  it('returns the prototype labels per kind', () => {
    expect(reqKindLabel('confirm')).toBe('需确认')
    expect(reqKindLabel('input')).toBe('需输入')
    expect(reqKindLabel('select')).toBe('需选择')
  })

  it('exposes an svg icon per kind', () => {
    expect(REQ_KIND_ICON.confirm).toContain('<path')
    expect(REQ_KIND_ICON.input).toContain('<path')
    expect(REQ_KIND_ICON.select).toContain('<path')
  })
})
