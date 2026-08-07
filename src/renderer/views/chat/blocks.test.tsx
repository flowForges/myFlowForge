import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { TableBlock, QuoteBlock, sortRows, nextSort, asNumber, isNumericColumn } from './blocks'

describe('asNumber / isNumericColumn', () => {
  it('读得出千分位、百分号、货币符号 —— 模型很爱这么写', () => {
    expect(asNumber('1,234')).toBe(1234)
    expect(asNumber('85%')).toBe(85)
    expect(asNumber('$99')).toBe(99)
    expect(asNumber('-3.5')).toBe(-3.5)
  })
  it('非数字返回 null', () => {
    expect(asNumber('规划')).toBeNull()
    expect(asNumber('')).toBeNull()
    expect(asNumber('3 个')).toBeNull()
  })
  it('整列非空单元格都是数字才算数值列', () => {
    expect(isNumericColumn([['1'], ['2'], ['10']], 0)).toBe(true)
    expect(isNumericColumn([['1'], [''], ['10']], 0)).toBe(true)     // 空洞不影响判定
    expect(isNumericColumn([['1'], ['两'], ['10']], 0)).toBe(false)
    expect(isNumericColumn([[''], ['']], 0)).toBe(false)             // 全空不是数值列
  })
})

describe('sortRows', () => {
  const rows = [['9', 'b'], ['10', 'a'], ['2', 'c']]
  it('数值列按数值排,不是按字符串 —— 否则 "10" 会排在 "9" 前面', () => {
    expect(sortRows(rows, { col: 0, dir: 'asc' }).map(r => r[0])).toEqual(['2', '9', '10'])
    expect(sortRows(rows, { col: 0, dir: 'desc' }).map(r => r[0])).toEqual(['10', '9', '2'])
  })
  it('文本列按 localeCompare(zh)', () => {
    const zh = [['', '北京'], ['', '上海'], ['', '广州']]
    expect(sortRows(zh, { col: 1, dir: 'asc' }).map(r => r[1])).toEqual(['北京', '广州', '上海'])
  })
  it('空单元格一律沉底,升降序都是', () => {
    const holes = [['b'], [''], ['a']]
    expect(sortRows(holes, { col: 0, dir: 'asc' }).map(r => r[0])).toEqual(['a', 'b', ''])
    expect(sortRows(holes, { col: 0, dir: 'desc' }).map(r => r[0])).toEqual(['b', 'a', ''])
  })
  it('sort 为 null 时原样返回(原序)', () => {
    expect(sortRows(rows, null)).toBe(rows)
  })
  it('不改动入参数组', () => {
    const orig = [['3'], ['1']]
    sortRows(orig, { col: 0, dir: 'asc' })
    expect(orig).toEqual([['3'], ['1']])
  })
})

describe('nextSort —— 三态循环', () => {
  it('原序 → 升 → 降 → 原序', () => {
    expect(nextSort(null, 1)).toEqual({ col: 1, dir: 'asc' })
    expect(nextSort({ col: 1, dir: 'asc' }, 1)).toEqual({ col: 1, dir: 'desc' })
    expect(nextSort({ col: 1, dir: 'desc' }, 1)).toBeNull()
  })
  it('换一列从升序重新开始', () => {
    expect(nextSort({ col: 1, dir: 'desc' }, 2)).toEqual({ col: 2, dir: 'asc' })
  })
})

describe('TableBlock', () => {
  const header = ['城市', '人口']
  const body = [['北京', '2189'], ['上海', '2487'], ['广州', '1868']]
  const bodyOf = (c: HTMLElement): string[][] =>
    Array.from(c.querySelectorAll('tbody tr')).map(tr => Array.from(tr.querySelectorAll('td')).map(td => td.textContent ?? ''))

  it('点表头排序,再点降序,第三次回到原序', () => {
    const { container } = render(<TableBlock header={header} body={body} tk={0} />)
    expect(bodyOf(container).map(r => r[0])).toEqual(['北京', '上海', '广州'])
    const sortBtn = container.querySelectorAll('.tbl-sort')[1] as HTMLElement   // 「人口」列
    fireEvent.click(sortBtn)
    expect(bodyOf(container).map(r => r[1])).toEqual(['1868', '2189', '2487'])
    fireEvent.click(sortBtn)
    expect(bodyOf(container).map(r => r[1])).toEqual(['2487', '2189', '1868'])
    fireEvent.click(sortBtn)
    expect(bodyOf(container).map(r => r[0])).toEqual(['北京', '上海', '广州'])   // 原序
  })

  it('排序状态反映在 aria-sort 上', () => {
    const { container } = render(<TableBlock header={header} body={body} tk={0} />)
    const th = () => container.querySelectorAll('thead th')[1]
    expect(th().getAttribute('aria-sort')).toBe('none')
    fireEvent.click(container.querySelectorAll('.tbl-sort')[1] as HTMLElement)
    expect(th().getAttribute('aria-sort')).toBe('ascending')
    fireEvent.click(container.querySelectorAll('.tbl-sort')[1] as HTMLElement)
    expect(th().getAttribute('aria-sort')).toBe('descending')
  })

  it('★ TSV 复制跟随当前排序 —— 复制到的必须是眼睛看到的那个顺序', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    const { container } = render(<TableBlock header={header} body={body} tk={0} />)
    fireEvent.click(container.querySelectorAll('.tbl-sort')[1] as HTMLElement)   // 按人口升序
    fireEvent.click(container.querySelector('.tbl-copy') as HTMLElement)
    expect(writeText).toHaveBeenCalledWith('城市\t人口\n广州\t1868\n北京\t2189\n上海\t2487')
    await waitFor(() => expect(container.querySelector('.tbl-copy.done')).toBeTruthy())
  })

  it('renderCell 缺省时按纯文本渲染(HTML 通道用)', () => {
    const { container } = render(<TableBlock header={['a']} body={[['**粗**']]} tk={0} />)
    expect(container.querySelector('td')?.textContent).toBe('**粗**')
    expect(container.querySelector('td strong')).toBeNull()
  })
})

describe('QuoteBlock', () => {
  it('复制的是纯文本,不带 > 标记', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    const { container } = render(<QuoteBlock text={'第一行\n第二行'}><span>第一行第二行</span></QuoteBlock>)
    const btn = container.querySelector('.bq-copy') as HTMLElement
    expect(btn).toBeTruthy()
    fireEvent.click(btn)
    expect(writeText).toHaveBeenCalledWith('第一行\n第二行')
    await waitFor(() => expect(container.querySelector('.bq-copy.done')).toBeTruthy())
  })
  it('仍然渲染成 blockquote(样式不变)', () => {
    const { container } = render(<QuoteBlock text="x"><span>x</span></QuoteBlock>)
    expect(container.querySelector('blockquote')).toBeTruthy()
  })
})
