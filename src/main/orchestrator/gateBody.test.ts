import { describe, it, expect } from 'vitest'
import { buildGateBody, outputFromLogs, pickDocArtifact, buildDesignDocs, gateBodyFromDoc } from './gateBody'

describe('pickDocArtifact', () => {
  it('picks the first .md artifact path', () => {
    expect(pickDocArtifact([{ path: 'docs/技术方案.md', kind: 'md' }])).toBe('docs/技术方案.md')
  })
  it('picks by kind md/markdown even if path lacks extension', () => {
    expect(pickDocArtifact([{ path: 'design/plan', kind: 'markdown' }])).toBe('design/plan')
  })
  it('ignores non-doc artifacts', () => {
    expect(pickDocArtifact([{ path: 'src/main.go', kind: 'code' }])).toBeUndefined()
    expect(pickDocArtifact([])).toBeUndefined()
    expect(pickDocArtifact(undefined)).toBeUndefined()
  })
  it('prefers a .md path when mixed with code artifacts', () => {
    expect(pickDocArtifact([{ path: 'a.go', kind: 'code' }, { path: 'b.md', kind: 'md' }])).toBe('b.md')
  })
})

describe('buildDesignDocs', () => {
  it('collects docs with cwd + name, in agent order, skipping agents without a doc', () => {
    const docs = buildDesignDocs(
      [{ id: 'a1', name: 'go-blog' }, { id: 'a2', name: 'zgh' }, { id: 's', name: '主代理' }],
      id => ({ a1: 'docs/go.md', s: '技术方案-总览.md' } as Record<string, string>)[id],
      id => ({ a1: '/ws/go', a2: '/ws/zgh', s: '/ws' } as Record<string, string>)[id],
    )
    expect(docs).toEqual([
      { path: 'docs/go.md', cwd: '/ws/go', name: 'go-blog' },
      { path: '技术方案-总览.md', cwd: '/ws', name: '主代理' },
    ])
  })
})

describe('gateBodyFromDoc', () => {
  const doc = { path: 'p.md', cwd: '/ws', name: '主代理' }
  it('returns the doc file content when readable', () => {
    expect(gateBodyFromDoc(doc, () => '# 总技术方案\n正文', () => 'fallback')).toBe('# 总技术方案\n正文')
  })
  it('falls back when there is no doc', () => {
    expect(gateBodyFromDoc(undefined, () => '', () => 'summary body')).toBe('summary body')
  })
  it('falls back when the doc file is empty/unreadable', () => {
    expect(gateBodyFromDoc(doc, () => undefined, () => 'summary body')).toBe('summary body')
    expect(gateBodyFromDoc(doc, () => '   ', () => 'summary body')).toBe('summary body')
  })
})

describe('buildGateBody', () => {
  it('returns a single agent handoff summary verbatim (no heading noise)', () => {
    const body = buildGateBody(
      [{ id: 'a1', name: '主代理' }],
      id => (id === 'a1' ? '## 技术方案\n采用 X 架构,分三步实施。' : undefined),
    )
    expect(body).toBe('## 技术方案\n采用 X 架构,分三步实施。')
  })

  it('joins multiple design agents under per-agent headings', () => {
    const body = buildGateBody(
      [{ id: 'a1', name: '前端设计' }, { id: 'a2', name: '后端设计' }],
      id => (id === 'a1' ? '前端走组件化' : '后端用网关'),
    )
    expect(body).toBe('### 前端设计\n\n前端走组件化\n\n### 后端设计\n\n后端用网关')
  })

  it('skips agents with no handoff and returns undefined when nothing usable', () => {
    expect(buildGateBody([{ id: 'a1', name: 'x' }], () => undefined)).toBeUndefined()
    expect(buildGateBody([{ id: 'a1', name: 'x' }], () => '   ')).toBeUndefined()
    expect(buildGateBody([], () => 'whatever')).toBeUndefined()
  })

  it('drops empty handoffs but keeps the rest', () => {
    const body = buildGateBody(
      [{ id: 'a1', name: '一' }, { id: 'a2', name: '二' }],
      id => (id === 'a1' ? '' : '方案二内容'),
    )
    expect(body).toBe('方案二内容')
  })

  it('falls back to the agent output when no handoff fence was emitted', () => {
    const body = buildGateBody(
      [{ id: 'a1', name: '主代理' }],
      () => undefined, // codex produced no handoff
      id => (id === 'a1' ? '## 技术方案\n用网关聚合。' : undefined),
    )
    expect(body).toBe('## 技术方案\n用网关聚合。')
  })

  it('prefers the handoff summary over the output fallback when both exist', () => {
    const body = buildGateBody(
      [{ id: 'a1', name: 'x' }],
      () => '权威交接摘要',
      () => '较长的原始输出',
    )
    expect(body).toBe('权威交接摘要')
  })
})

describe('outputFromLogs', () => {
  it('joins only output-kind lines, dropping think/tool/file noise', () => {
    const text = outputFromLogs([
      { ts: '0', text: '思考中', level: 'info', kind: 'think' },
      { ts: '0', text: '第一段方案', level: 'ok', kind: 'output' },
      { ts: '0', text: '调用 shell', level: 'accent', kind: 'tool' },
      { ts: '0', text: '第二段方案', level: 'ok', kind: 'output' },
    ])
    expect(text).toBe('第一段方案\n第二段方案')
  })

  it('returns empty string when there are no output lines', () => {
    expect(outputFromLogs([{ ts: '0', text: 'x', level: 'info' }])).toBe('')
    expect(outputFromLogs(undefined)).toBe('')
  })
})
