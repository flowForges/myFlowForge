import { describe, it, expect } from 'vitest'
import { parseHandoffResult } from './handoffResult'

describe('parseHandoffResult', () => {
  it('falls back to plain summary when no structured block', () => {
    const r = parseHandoffResult({ summary: '改完了', artifacts: [{ path: 'a.md', kind: 'doc' }] })
    expect(r.summary).toBe('改完了')
    expect(r.filesChanged).toEqual([])
    expect(r.blockers).toEqual([])
    expect(r.doubts).toEqual([])
    expect(r.artifacts).toEqual([{ path: 'a.md', kind: 'doc' }])
    expect(r.testsRun).toBeUndefined()
  })

  it('extracts structured fields from a forge-result fenced block', () => {
    const summary = [
      '做完了。',
      '```forge-result',
      JSON.stringify({
        project: 'payment-api',
        summary: '实现幂等键',
        filesChanged: ['src/pay.ts', 'src/idem.ts'],
        testsRun: { passed: true, detail: '12 passed' },
        doubts: ['是否要全局锁'],
      }),
      '```',
    ].join('\n')
    const r = parseHandoffResult({ summary })
    expect(r.project).toBe('payment-api')
    expect(r.summary).toBe('实现幂等键')
    expect(r.filesChanged).toEqual(['src/pay.ts', 'src/idem.ts'])
    expect(r.testsRun).toEqual({ passed: true, detail: '12 passed' })
    expect(r.doubts).toEqual(['是否要全局锁'])
    expect(r.blockers).toEqual([])
  })

  it('tolerates malformed JSON in the block and falls back', () => {
    const summary = '半截\n```forge-result\n{ not json ]\n```'
    const r = parseHandoffResult({ summary })
    expect(r.summary).toBe(summary)
    expect(r.filesChanged).toEqual([])
  })
})
