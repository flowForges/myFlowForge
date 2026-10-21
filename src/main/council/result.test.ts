import { describe, it, expect } from 'vitest'
import { parseCouncilResult, parseVote, renderCouncilMarkdown, councilFileName } from './result'
import { COUNCIL_RESULT_FENCE } from './prompts'
import type { CouncilState } from '@shared/council'
import type { Utterance } from './transcript'

const fence = (json: string) => `${COUNCIL_RESULT_FENCE}\n${json}\n\`\`\``

describe('parseCouncilResult', () => {
  it('parses a valid fence', () => {
    const json = JSON.stringify({
      conclusion: '用 A',
      candidates: [{ name: 'A', points: 'p', pros: 'x', cons: 'y', supporters: ['s1'], dissenters: [] }],
      recommended: { name: 'A', reason: 'r' },
      disagreements: [{ seat: 's2', point: 'pt', reason: 'rs' }],
    })
    const { result, body } = parseCouncilResult(fence(json))
    expect(result?.conclusion).toBe('用 A')
    expect(result?.candidates).toHaveLength(1)
    expect(result?.recommended?.name).toBe('A')
    expect(result?.disagreements).toHaveLength(1)
    expect(body).toBe('')
  })

  it('removes the fence from body but keeps prose around it', () => {
    const text = `前文\n${fence('{"conclusion":"c"}')}\n后文`
    const { result, body } = parseCouncilResult(text)
    expect(result?.conclusion).toBe('c')
    expect(body).toContain('前文')
    expect(body).toContain('后文')
    expect(body).not.toContain('forge:council-result')
    expect(body).not.toContain('"conclusion"')
  })

  it('returns null result and original text without a fence', () => {
    expect(parseCouncilResult('只是文字')).toEqual({ result: null, body: '只是文字' })
  })

  it('does not throw on malformed JSON and keeps the text', () => {
    const text = fence('{oops')
    const r = parseCouncilResult(text)
    expect(r.result).toBeNull()
    expect(r.body).toBe(text)
  })

  it('returns null for an unclosed fence', () => {
    const text = `${COUNCIL_RESULT_FENCE}\n{"conclusion":"c"}`
    expect(parseCouncilResult(text)).toEqual({ result: null, body: text })
  })

  it('defaults missing candidates and disagreements to []', () => {
    const { result } = parseCouncilResult(fence('{"conclusion":"c"}'))
    expect(result?.candidates).toEqual([])
    expect(result?.disagreements).toEqual([])
    expect(result?.recommended).toBeUndefined()
  })

  it('accepts an indented opener line', () => {
    const { result } = parseCouncilResult(`  ${COUNCIL_RESULT_FENCE}\n{"conclusion":"c"}\n  \`\`\``)
    expect(result?.conclusion).toBe('c')
  })
})

describe('parseVote', () => {
  it('detects agree', () => expect(parseVote('同意。理由…')).toBe('agree'))
  it('disagree is not matched as agree', () => expect(parseVote('不同意,因为')).toBe('disagree'))
  it('tolerates leading whitespace and markdown', () => {
    expect(parseVote('  **不同意** 理由')).toBe('disagree')
    expect(parseVote('\n**同意**')).toBe('agree')
  })
  it('unknown otherwise', () => expect(parseVote('嗯')).toBe('unknown'))
})

const state = (over: Partial<CouncilState> = {}): CouncilState => ({
  id: 'c1', workspacePath: '/ws', sessionId: 's', status: 'done', round: 2, totalRounds: 2,
  speaking: [], startedAt: 0, elapsedMs: 0,
  config: {
    topic: '选哪个数据库', attachments: [],
    seats: [
      { id: 'a', provider: 'claude', model: 'x', label: 'Claude · X' },
      { id: 'b', provider: 'codex', model: 'y', label: 'Codex · Y' },
    ],
    leader: { id: 'l', provider: 'claude', model: 'x', label: 'Claude · Lead' },
    mode: { kind: 'rounds', rounds: 2 },
  },
  ...over,
})
const u = (text: string, stage: Utterance['stage'] = 'summary', round = 1): Utterance => ({ seat: 'l', label: 'Claude · Lead', round, stage, text })

describe('renderCouncilMarkdown', () => {
  const result = {
    conclusion: '结论正文',
    candidates: [{ name: '方案甲', points: 'pp', pros: 'pro', cons: 'con', supporters: ['Claude · X'], dissenters: [{ seat: 'Codex · Y', reason: '太贵' }] }],
    recommended: { name: '方案甲', reason: '稳' },
    disagreements: [{ seat: 'Codex · Y', point: '成本', reason: '贵' }],
  }

  it('includes topic, seats, conclusion, candidates, summaries', () => {
    const md = renderCouncilMarkdown(state(), [u('第一轮总结')], result, '', [])
    for (const s of ['选哪个数据库', 'Claude · X', 'Codex · Y', '结论正文', '方案甲', '稳', '太贵', '成本', '第一轮总结']) expect(md).toContain(s)
    expect(md).not.toContain('追问')
  })

  it('a multi-line topic gets a one-line H1 and the full text in a quoted 议题 section', () => {
    const topic = '帮我审查这个方案\n# 背景\n- 第一点\n1. 第二点'
    const md = renderCouncilMarkdown(state({ config: { ...state().config, topic } }), [], result, '', [])
    const lines = md.split('\n')
    expect(lines[0]).toBe('# AI 共商:帮我审查这个方案 # 背景 - 第一点 1. 第二点')
    // 议题原文只出现在引用块里,不会变成游离的标题 / 列表
    expect(lines.filter(l => l.startsWith('# '))).toHaveLength(1)
    expect(lines).not.toContain('- 第一点')
    expect(lines).not.toContain('1. 第二点')
    expect(md).toContain('## 议题\n\n> 帮我审查这个方案\n> # 背景\n> - 第一点\n> 1. 第二点\n')
    expect(md.indexOf('## 议题')).toBeLessThan(md.indexOf('## 讨论方'))
  })

  it('records the chosen candidate', () => {
    const md = renderCouncilMarkdown(state({ chosen: '方案甲' }), [], result, '', [])
    expect(md).toContain('选定')
    expect(md.split('选定')[1]).toContain('方案甲')
  })

  it('has no chosen line when not chosen', () => {
    expect(renderCouncilMarkdown(state(), [], result, '', [])).not.toContain('选定')
  })

  it('appends followups', () => {
    const md = renderCouncilMarkdown(state(), [], result, '', [u('追问的回答', 'followup', 3)])
    expect(md).toContain('追问')
    expect(md).toContain('追问的回答')
  })

  it('falls back to the raw text when result is null', () => {
    const md = renderCouncilMarkdown(state(), [], null, '领导者原文', [])
    expect(md).toContain('领导者原文')
  })
})

describe('councilFileName', () => {
  const t = new Date(2026, 9, 21, 15, 30).getTime()
  it('formats date, time and slug', () => {
    expect(councilFileName(t, 'hello world', '3f9a2c1b-77aa-4e00-9c1d-0123456789ab')).toBe('2026-10-21-1530-hello-world-3f9a2c.md')
  })
  it('two councils with the same topic in the same minute get different files', () => {
    expect(councilFileName(t, '同一个议题', 'aaaaaa11-0000')).not.toBe(councilFileName(t, '同一个议题', 'bbbbbb22-0000'))
  })
  it('strips unsafe chars and keeps CJK', () => {
    const n = councilFileName(t, 'a/b\\c:d*e?f"g<h>i|j 选型', 'id1')
    expect(n).not.toMatch(/[/\\:*?"<>|]/)
    expect(n).toContain('选型')
  })
  it('caps slug at 40 chars', () => {
    const n = councilFileName(t, '议'.repeat(100), 'abcdef12')
    expect(n.slice('2026-10-21-1530-'.length, -'-abcdef.md'.length)).toHaveLength(40)
  })
  it('falls back when slug is empty', () => {
    expect(councilFileName(t, '///', 'abcdef12')).toBe('2026-10-21-1530-council-abcdef.md')
  })
})
