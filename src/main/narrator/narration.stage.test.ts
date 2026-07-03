import { describe, it, expect } from 'vitest'
import { buildStageNote } from './narration'
import type { StageRuntime, LogLine } from '@shared/types'

function log(text: string, level: LogLine['level'] = 'info'): LogLine {
  return { ts: '00:00:00', text, level }
}

function stage(over: Partial<StageRuntime> & Pick<StageRuntime, 'agents'>): StageRuntime {
  return { key: 'design', name: '设计', state: 'ok', ...over }
}

describe('buildStageNote', () => {
  it('completed stage with handoff summaries: ✓ + name + 完成 + count + 交接 segment', () => {
    const s = stage({
      name: '设计', state: 'ok',
      agents: [
        { id: 'a1', name: 'arch', role: 'r', provider: 'claude', model: 'm', state: 'ok', logs: [log('交接 → 做了X', 'accent')] },
        { id: 'a2', name: 'ui', role: 'r', provider: 'claude', model: 'm', state: 'ok', logs: [log('交接 → 做了Y', 'accent')] }
      ]
    })
    const note = buildStageNote(s)
    expect(note).toContain('✓')
    expect(note).toContain('设计')
    expect(note).toContain('完成')
    expect(note).toContain('2 代理')
    expect(note).toContain('交接')
    expect(note).toContain('做了X')
    expect(note).toContain('做了Y')
    // handoff prefix stripped
    expect(note).not.toContain('交接 → ')
  })

  it('failed stage: includes name + 失败 + tail of error lines (up to 3), no 交接 segment', () => {
    const s = stage({
      name: '开发', state: 'err',
      agents: [{
        id: 'a1', name: 'web', role: 'r', provider: 'claude', model: 'm', state: 'err',
        logs: [
          log('错误: e1'), log('错误: e2'), log('错误: e3'), log('错误: e4')
        ]
      }]
    })
    const note = buildStageNote(s)
    expect(note).toContain('开发')
    expect(note).toContain('失败')
    expect(note).toContain('错误')
    // tail of last ~3 error lines: e1 dropped, e2..e4 kept
    expect(note).toContain('e4')
    expect(note).toContain('e3')
    expect(note).toContain('e2')
    expect(note).not.toContain('e1')
    expect(note).not.toContain('交接')
  })

  it('fallback: agents but no handoff and no error → name · statusZh · N 代理, no 交接', () => {
    const s = stage({
      name: '测试', state: 'ok',
      agents: [{ id: 'a1', name: 't', role: 'r', provider: 'claude', model: 'm', state: 'ok', logs: [log('普通日志')] }]
    })
    const note = buildStageNote(s)
    expect(note).toContain('测试')
    expect(note).toContain('完成')
    expect(note).toContain('1 代理')
    expect(note).not.toContain('交接')
    expect(note).not.toContain('错误')
  })

  it('no handoff but real output → includes the plan body so it reaches the conversation', () => {
    const s = stage({
      key: 'design', name: '技术方案设计', state: 'ok',
      agents: [{
        id: 'a1', name: '主代理', role: 'r', provider: 'codex', model: 'm', state: 'ok',
        logs: [
          { ts: '0', text: '读取仓库上下文', level: 'accent', kind: 'tool' },
          { ts: '0', text: '## 技术方案\n采用分层架构。', level: 'ok', kind: 'output' },
        ],
      }],
    })
    const note = buildStageNote(s)
    expect(note).toContain('技术方案设计')
    expect(note).toContain('## 技术方案')
    expect(note).toContain('采用分层架构')
    // tool-kind process noise is NOT dumped into the plan body
    expect(note).not.toContain('读取仓库上下文')
  })

  it('review stage note uses the grouped CR report (per reviewer)', () => {
    const s = {
      key: 'review', name: '代码 CR', state: 'ok' as const,
      agents: [
        { id: 'review:web', name: 'web', role: '代码 CR', provider: 'claude', model: 'm', state: 'ok' as const, logs: [{ ts: '0', text: '交接 → web 没问题', level: 'accent' as const }] },
        { id: 'review:api', name: 'api', role: '代码 CR', provider: 'claude', model: 'm', state: 'ok' as const, logs: [{ ts: '0', text: '交接 → api 有注入风险', level: 'accent' as const }] },
      ],
    }
    const note = buildStageNote(s)
    expect(note).toContain('代码 CR 汇总')
    expect(note).toContain('web 没问题')
    expect(note).toContain('api 有注入风险')
  })

  it('non-review stage note keeps the legacy one-line format', () => {
    const s = {
      key: 'develop', name: '代码开发', state: 'ok' as const,
      agents: [{ id: 'develop:web', name: 'web', role: '代码开发', provider: 'claude', model: 'm', state: 'ok' as const, logs: [{ ts: '0', text: '交接 → 实现完成', level: 'accent' as const }] }],
    }
    expect(buildStageNote(s)).not.toContain('代码 CR 汇总')
  })
})

describe('buildStageNote 设计文档路径', () => {
  it('存在 文档 → 日志行时,末尾追加 📄 设计文档 提示', () => {
    const s: any = {
      key: 'design', name: '技术方案设计', state: 'ok',
      agents: [{
        name: 'A', logs: [
          { ts: '00:00:01', text: '交接 → 方案要点', level: 'accent' },
          { ts: '00:00:02', text: '文档 → docs/plan/方案.md', level: 'accent' },
        ],
      }],
    }
    const note = buildStageNote(s)
    expect(note).toContain('📄 设计文档:docs/plan/方案.md')
    expect(note).toContain('点上方门控卡「打开文档」查看全文')
  })
  it('无 文档 → 行时不含 📄', () => {
    const s: any = { key: 'design', name: '技术方案设计', state: 'ok',
      agents: [{ name: 'A', logs: [{ ts: '00:00:01', text: '交接 → x', level: 'accent' }] }] }
    expect(buildStageNote(s)).not.toContain('📄')
  })
})
