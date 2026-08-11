import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { AskQuestion } from '@shared/types'
import { AskQuestionCard } from './AskQuestionCard'

const SINGLE: AskQuestion[] = [{
  question: '配置文件用哪种格式？',
  header: '配置格式',
  multiSelect: false,
  options: [
    { label: 'JSON', description: '通用性最好' },
    { label: 'YAML', description: '可读性强' },
    { label: 'TOML', description: '语法清晰' },
  ],
}]

const mk = (questions: AskQuestion[]) => {
  const onResolve = vi.fn()
  const r = render(<AskQuestionCard id="cc-1" questions={questions} agentName="主代理" provider="claude" onResolve={onResolve} />)
  return { onResolve, ...r }
}

describe('AskQuestionCard', () => {
  it('把每个选项都画出来(bug 里它们一个都看不到)', () => {
    const { container } = mk(SINGLE)
    expect(screen.getByText('配置文件用哪种格式？')).toBeInTheDocument()
    expect(container.querySelectorAll('.req-opt')).toHaveLength(3)
    for (const label of ['JSON', 'YAML', 'TOML']) expect(screen.getByText(label)).toBeInTheDocument()
    // 说明文字也要在,否则用户没法判断该选哪个。
    expect(screen.getByText('通用性最好')).toBeInTheDocument()
  })

  it('单选题点一下就答完,答案按问题原文回传', async () => {
    const { onResolve } = mk(SINGLE)
    fireEvent.click(screen.getByText('TOML'))
    expect(onResolve).toHaveBeenCalledWith({ id: 'cc-1', decision: 'allow', answers: { '配置文件用哪种格式？': ['TOML'] } })
  })

  it('多选题先勾后交,一次带上全部选择', async () => {
    const multi: AskQuestion[] = [{ question: '要哪几项？', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }]
    const { onResolve, container } = mk(multi)
    fireEvent.click(screen.getByText('A'))
    fireEvent.click(screen.getByText('C'))
    // 勾了还没交 —— 不能提前把答案发出去。
    expect(onResolve).not.toHaveBeenCalled()
    expect(container.querySelectorAll('.req-opt.picked')).toHaveLength(2)
    fireEvent.click(screen.getByText('提交'))
    expect(onResolve).toHaveBeenCalledWith({ id: 'cc-1', decision: 'allow', answers: { '要哪几项？': ['A', 'C'] }, response: undefined })
  })

  it('多选可反选', async () => {
    const multi: AskQuestion[] = [{ question: 'q', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }]
    const { onResolve } = mk(multi)
    fireEvent.click(screen.getByText('A'))
    fireEvent.click(screen.getByText('B'))
    fireEvent.click(screen.getByText('A'))
    fireEvent.click(screen.getByText('提交'))
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ answers: { q: ['B'] } }))
  })

  it('多题时逐题记录,一次提交(不能点第一题就把没答的题送出去)', async () => {
    const two: AskQuestion[] = [
      { question: '第一题？', options: [{ label: 'A1' }, { label: 'A2' }] },
      { question: '第二题？', options: [{ label: 'B1' }, { label: 'B2' }] },
    ]
    const { onResolve } = mk(two)
    fireEvent.click(screen.getByText('A2'))
    expect(onResolve).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('B1'))
    fireEvent.click(screen.getByText('提交'))
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ answers: { '第一题？': ['A2'], '第二题？': ['B1'] } }))
  })

  it('选项都不合适时可以直接打字回答(用户明确要的兜底)', async () => {
    const { onResolve } = mk(SINGLE)
    const input = screen.getByPlaceholderText('以上都不合适？直接输入你的回答…')
    fireEvent.change(input, { target: { value: '我要用 INI' } })
    fireEvent.click(screen.getByText('提交'))
    expect(onResolve).toHaveBeenCalledWith({ id: 'cc-1', decision: 'allow', answers: {}, response: '我要用 INI' })
  })

  it('既没选也没写时,提交是禁用的(避免送出一个空回答)', () => {
    mk(SINGLE)
    expect(screen.getByText('提交')).toBeDisabled()
  })

  it('「不回答」发 deny —— 模型该知道被跳过,而不是干等', async () => {
    const { onResolve } = mk(SINGLE)
    fireEvent.click(screen.getByText('不回答'))
    expect(onResolve).toHaveBeenCalledWith({ id: 'cc-1', decision: 'deny' })
  })

  it('问题与选项是模型输出,一律当纯文本渲染', () => {
    const evil: AskQuestion[] = [{ question: '<img src=x onerror=alert(1)>', options: [{ label: '<b>粗</b>' }] }]
    const { container } = mk(evil)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.req-opt b')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
  })
})
