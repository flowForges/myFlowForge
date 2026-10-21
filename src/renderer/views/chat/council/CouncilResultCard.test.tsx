import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CouncilResultCard, councilResultMarkdown } from './CouncilResultCard'
import type { ChatMessage } from '@shared/types'
import type { CouncilResult } from '@shared/council'

const result: CouncilResult = {
  conclusion: '两种都可行',
  candidates: [
    { name: '方案A', points: 'A 要点', pros: 'A 优点', cons: 'A 代价', supporters: ['claude:opus'], dissenters: [] },
    { name: '方案B', points: 'B 要点', pros: 'B 优点', cons: 'B 代价', supporters: ['codex:gpt-6'], dissenters: [{ seat: 'claude:opus', reason: '太重' }] },
  ],
  recommended: { name: '方案B', reason: '更稳' },
  disagreements: [{ seat: 'codex:gpt-6', point: '迁移节奏', reason: '担心回归' }],
}

const final = (r?: CouncilResult, text = '原文'): ChatMessage => ({
  id: 'c1:2:leader:claude:opus:final', who: 'ai', text, ts: '2026-10-21T10:00:00Z',
  council: { id: 'c1', seat: 'leader:claude:opus', round: 2, stage: 'final' }, ...(r ? { councilResult: r } : {}),
})

const labels: Record<string, string> = { 'claude:opus': 'Claude Code · Opus', 'codex:gpt-6': 'Codex · GPT-6' }
const seatLabel = (id: string) => labels[id] ?? id

describe('CouncilResultCard', () => {
  it('candidate tabs: recommended first with ★', () => {
    render(<CouncilResultCard final={final(result)} seatLabel={seatLabel} onChoose={vi.fn()} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(t => t.textContent)).toEqual(['★方案B', '方案A'])
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('B 优点')).toBeTruthy()
    expect(screen.getByText('B 代价')).toBeTruthy()
    expect(screen.getByText('太重')).toBeTruthy()
    expect(screen.getByText('担心回归')).toBeTruthy()
  })

  it('switching tabs shows that candidate', () => {
    render(<CouncilResultCard final={final(result)} seatLabel={seatLabel} onChoose={vi.fn()} />)
    fireEvent.click(screen.getAllByRole('tab')[1])
    expect(screen.getByText('A 优点')).toBeTruthy()
  })

  it('选定 calls choose with the shown candidate; chosen tab is marked', () => {
    const onChoose = vi.fn()
    const { rerender } = render(<CouncilResultCard final={final(result)} seatLabel={seatLabel} onChoose={onChoose} />)
    fireEvent.click(screen.getByRole('button', { name: '选定' }))
    expect(onChoose).toHaveBeenCalledWith('方案B')
    rerender(<CouncilResultCard final={final(result)} chosen="方案B" seatLabel={seatLabel} onChoose={onChoose} />)
    expect(screen.getAllByRole('tab')[0].getAttribute('data-chosen')).toBe('true')
    expect(screen.getByRole('button', { name: '选定' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('fallback renders the final text when councilResult is absent', () => {
    render(<CouncilResultCard final={final(undefined, '无结构的结论')} seatLabel={seatLabel} onChoose={vi.fn()} />)
    expect(screen.getByText('无结构的结论')).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('复制 Markdown: a multi-line topic gets a one-line H1 and the full text quoted', () => {
    const md = councilResultMarkdown('第一行\n# 背景\n- 一点', result, '原文', undefined, seatLabel)
    expect(md.startsWith('# AI 共商:第一行 # 背景 - 一点\n\n> 第一行\n> # 背景\n> - 一点\n\n')).toBe(true)
  })

  it('复制 Markdown copies the result as markdown', async () => {
    const writeText = vi.fn(async (_t: string) => {})
    Object.assign(navigator, { clipboard: { writeText } })
    render(<CouncilResultCard final={final(result)} topic="议题" seatLabel={seatLabel} onChoose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '复制 Markdown' }))
    expect(writeText).toHaveBeenCalledWith(councilResultMarkdown('议题', result, '原文', undefined, seatLabel))
    const md = writeText.mock.calls[0][0] as string
    expect(md).toContain('两种都可行')
    expect(md).toContain('方案B ★')
    expect(md).toContain('Codex · GPT-6')
  })
})
