import { describe, it, expect } from 'vitest'
import { CH } from './channels'
describe('IPC channels', () => {
  it('are all unique', () => {
    const vals = Object.values(CH)
    expect(new Set(vals).size).toBe(vals.length)
  })
})
