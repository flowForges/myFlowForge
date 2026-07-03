import { describe, it, expect } from 'vitest'
import { buildReviewReport } from './reviewReport'
import type { StageRuntime, AgentRuntime } from '@shared/types'

const log = (text: string) => ({ ts: '00:00:00', text, level: 'accent' as const })
const reviewer = (id: string, name: string, summaries: string[]): AgentRuntime => ({
  id, name, role: '代码 CR', provider: 'claude', model: 'm', state: 'ok',
  logs: summaries.map(s => log(`交接 → ${s}`)),
})

const stage = (agents: AgentRuntime[], state: StageRuntime['state'] = 'ok'): StageRuntime =>
  ({ key: 'review', name: '代码 CR', state, agents })

describe('buildReviewReport', () => {
  it('groups each reviewer handoff under its name (project) into one report', () => {
    const s = stage([
      reviewer('review:web', 'web', ['登录态未失效，建议清 token']),
      reviewer('review:api', 'api', ['SQL 拼接有注入风险']),
    ])
    const report = buildReviewReport(s)
    expect(report).toContain('代码 CR 汇总')
    expect(report).toContain('web')
    expect(report).toContain('登录态未失效，建议清 token')
    expect(report).toContain('api')
    expect(report).toContain('SQL 拼接有注入风险')
    expect(report.indexOf('web')).toBeLessThan(report.indexOf('api'))
  })

  it('is idempotent — same stage in -> byte-identical report (zero side effects)', () => {
    const s = stage([reviewer('review:web', 'web', ['a']), reviewer('review:api', 'api', ['b'])])
    expect(buildReviewReport(s)).toBe(buildReviewReport(s))
  })

  it('uses the reviewer name as the group key (lens reviewers grouped by lens label)', () => {
    const s = stage([
      reviewer('review:workspace:correctness', '代码 CR · 正确性', ['边界条件漏判']),
      reviewer('review:workspace:security', '代码 CR · 安全', ['缺鉴权']),
    ])
    const report = buildReviewReport(s)
    expect(report).toContain('正确性')
    expect(report).toContain('安全')
  })

  it('a reviewer with no handoff still appears with a 无交接 marker', () => {
    const s = stage([reviewer('review:web', 'web', []), reviewer('review:api', 'api', ['ok'])])
    const report = buildReviewReport(s)
    expect(report).toContain('web')
    expect(report).toMatch(/web[\s\S]*无交接/)
  })

  it('surfaces errors when the stage failed (reuses error log lines)', () => {
    const failed: AgentRuntime = {
      id: 'review:web', name: 'web', role: '代码 CR', provider: 'claude', model: 'm', state: 'err',
      logs: [{ ts: '00:00:00', text: '错误: reviewer 超时', level: 'info' }],
    }
    const report = buildReviewReport(stage([failed], 'err'))
    expect(report).toContain('reviewer 超时')
  })
})
