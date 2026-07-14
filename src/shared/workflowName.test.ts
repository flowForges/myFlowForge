import { describe, it, expect } from 'vitest'
import { workflowNameTaken } from './workflowName'

describe('workflowNameTaken', () => {
  it('detects an exact match', () => {
    expect(workflowNameTaken('快速修复', ['标准工作流', '快速修复'])).toBe(true)
  })
  it('is trim- and case-insensitive', () => {
    expect(workflowNameTaken('  Quick Fix ', ['quick fix'])).toBe(true)
    expect(workflowNameTaken('标准工作流 ', ['标准工作流'])).toBe(true)
  })
  it('returns false for a fresh name', () => {
    expect(workflowNameTaken('重构流', ['标准工作流', '快速修复'])).toBe(false)
  })
  it('treats empty/whitespace as not taken', () => {
    expect(workflowNameTaken('', ['x'])).toBe(false)
    expect(workflowNameTaken('   ', ['x'])).toBe(false)
  })
})
