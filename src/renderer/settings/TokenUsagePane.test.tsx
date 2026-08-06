import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TokenUsagePane, sortGroups, TU_PAGE_SIZE, type TuGroup } from './TokenUsagePane'
import type { TokenUsageRow } from '../../main/ipc/tokenUsageHandlers'

const row = (o: Partial<TokenUsageRow>): TokenUsageRow => ({
  day: '2026-08-01', workspace: 'ws-a', provider: 'claude',
  input: 0, output: 0, turns: 0, estimated: false, ...o,
} as TokenUsageRow)

const setRows = (rows: TokenUsageRow[]) => {
  ;(window as any).forge = { tokenUsageAggregate: vi.fn(async () => rows) }
}

beforeEach(() => setRows([]))

const g = (o: Partial<TuGroup>): TuGroup =>
  ({ label: 'x', sub: '', input: 0, output: 0, turns: 0, estimated: false, ...o })

describe('sortGroups', () => {
  const rows = [
    g({ label: '2026-08-01', input: 10, output: 1, turns: 5 }),
    g({ label: '2026-08-03', input: 2, output: 30, turns: 1 }),
    g({ label: '2026-08-02', input: 5, output: 5, turns: 9 }),
  ]

  it('按标签升/降序', () => {
    expect(sortGroups(rows, 'label', 'asc').map(r => r.label)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03'])
    expect(sortGroups(rows, 'label', 'desc').map(r => r.label)).toEqual(['2026-08-03', '2026-08-02', '2026-08-01'])
  })

  it('按输入/输出/轮次排序', () => {
    expect(sortGroups(rows, 'input', 'desc').map(r => r.input)).toEqual([10, 5, 2])
    expect(sortGroups(rows, 'output', 'desc').map(r => r.output)).toEqual([30, 5, 1])
    expect(sortGroups(rows, 'turns', 'asc').map(r => r.turns)).toEqual([1, 5, 9])
  })

  it('按合计排序(input+output,不是任一单列)', () => {
    // 合计: 11 / 32 / 10 —— 与按 input 或按 output 的顺序都不同,能证明确实用的是和。
    expect(sortGroups(rows, 'total', 'desc').map(r => r.label)).toEqual(['2026-08-03', '2026-08-01', '2026-08-02'])
  })

  it('不改动入参数组', () => {
    const before = rows.map(r => r.label)
    sortGroups(rows, 'input', 'asc')
    expect(rows.map(r => r.label)).toEqual(before)
  })
})

describe('TokenUsagePane 分组副标题', () => {
  // 修复前:sub 取「合并进来的第一条」,于是按天分组时那天明明跨了 3 个工作区,却只显示其中一个。
  it('按天分组时列出该天覆盖的所有 工作区·provider,而不是只显示第一条', async () => {
    setRows([
      row({ day: '2026-08-01', workspace: 'ws-a', provider: 'claude', input: 1 }),
      row({ day: '2026-08-01', workspace: 'ws-b', provider: 'codex', input: 1 }),
    ])
    render(<TokenUsagePane />)
    await screen.findByText('2026-08-01')
    const sub = document.querySelector('.tu-lbl i')!.textContent ?? ''
    expect(sub).toContain('ws-a · claude')
    expect(sub).toContain('ws-b · codex')
  })

  it('超过 3 项时收尾为「等 N 项」,不把一行撑爆', async () => {
    setRows(['a', 'b', 'c', 'd', 'e'].map(w => row({ day: '2026-08-01', workspace: `ws-${w}`, input: 1 })))
    render(<TokenUsagePane />)
    await screen.findByText('2026-08-01')
    expect(document.querySelector('.tu-lbl i')!.textContent).toContain('等 5 项')
  })
})

describe('TokenUsagePane 排序与分页', () => {
  const manyDays = (n: number) => Array.from({ length: n }, (_, i) =>
    row({ day: `2026-06-${String(i + 1).padStart(2, '0')}`, input: i, output: 0, turns: 1 }))

  it('默认按天倒序(最近在前) —— 与改动前行为一致', async () => {
    setRows([row({ day: '2026-08-01' }), row({ day: '2026-08-03' }), row({ day: '2026-08-02' })])
    render(<TokenUsagePane />)
    await screen.findByText('2026-08-03')
    const labels = [...document.querySelectorAll('.tu-lbl b')].map(n => n.textContent?.replace('≈估算', ''))
    expect(labels).toEqual(['2026-08-03', '2026-08-02', '2026-08-01'])
  })

  it('点表头可换列排序,再点同一列反向', async () => {
    setRows([
      row({ day: '2026-08-01', input: 100 }),
      row({ day: '2026-08-02', input: 5 }),
      row({ day: '2026-08-03', input: 50 }),
    ])
    render(<TokenUsagePane />)
    await screen.findByText('2026-08-03')

    fireEvent.click(screen.getByRole('button', { name: /^输入/ }))
    await waitFor(() => {
      const labels = [...document.querySelectorAll('.tu-lbl b')].map(n => n.textContent)
      expect(labels[0]).toBe('2026-08-01')   // 输入最大
    })

    fireEvent.click(screen.getByRole('button', { name: /^输入/ }))
    await waitFor(() => {
      const labels = [...document.querySelectorAll('.tu-lbl b')].map(n => n.textContent)
      expect(labels[0]).toBe('2026-08-02')   // 反向 → 输入最小
    })
  })

  it('行数超过一页时分页,只渲染当页', async () => {
    setRows(manyDays(TU_PAGE_SIZE + 7))
    render(<TokenUsagePane />)
    await waitFor(() => expect(document.querySelectorAll('.tu-lbl b').length).toBe(TU_PAGE_SIZE))
    expect(screen.getByText(new RegExp(`第 1 / 2 页 · 共 ${TU_PAGE_SIZE + 7} 行`))).toBeTruthy()

    fireEvent.click(screen.getByText('下一页'))
    await waitFor(() => expect(document.querySelectorAll('.tu-lbl b').length).toBe(7))
  })

  it('行数不足一页时不显示分页条', async () => {
    setRows(manyDays(3))
    render(<TokenUsagePane />)
    await screen.findByText('2026-06-01')
    expect(document.querySelector('.tu-pager')).toBeNull()
  })

  it('改排序后回到第一页(否则会停在超出范围的空白页)', async () => {
    setRows(manyDays(TU_PAGE_SIZE + 7))
    render(<TokenUsagePane />)
    await waitFor(() => expect(document.querySelector('.tu-pager')).toBeTruthy())

    fireEvent.click(screen.getByText('下一页'))
    await waitFor(() => expect(screen.getByText(/第 2 \/ 2 页/)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /^轮次/ }))
    await waitFor(() => expect(screen.getByText(/第 1 \/ 2 页/)).toBeTruthy())
  })
})
