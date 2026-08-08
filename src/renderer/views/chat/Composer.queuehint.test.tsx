import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Composer } from './Composer'
import type { ProviderInfo } from '@shared/types'

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8', description: '' }] },
]
beforeEach(() => { (window as any).forge = { openFiles: vi.fn(async () => []), savePaste: vi.fn() } })

const HINT = /这条会排队/
const typeInto = (v: string) => {
  const ta = screen.getByRole('textbox') as HTMLTextAreaElement
  fireEvent.change(ta, { target: { value: v } })
}

describe('排队提示', () => {
  it('★ 打字之后仍然看得到 —— placeholder 一打字就没了,而按回车正是那一刻', () => {
    render(<Composer providers={providers} disabled={false} busy onSend={() => {}} />)
    // 空输入框时 placeholder 已经在说这件事
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).placeholder).toMatch(/排队/)
    typeInto('那就选第 2 种')
    expect(screen.getByText(HINT)).toBeTruthy()
  })

  it('不忙时不出现', () => {
    render(<Composer providers={providers} disabled={false} onSend={() => {}} />)
    typeInto('普通消息')
    expect(screen.queryByText(HINT)).toBeNull()
  })

  it('忙但没输入内容时不出现(placeholder 已经在说了,不重复占地方)', () => {
    render(<Composer providers={providers} disabled={false} busy onSend={() => {}} />)
    expect(screen.queryByText(HINT)).toBeNull()
  })

  it('只有空白字符不算输入', () => {
    render(<Composer providers={providers} disabled={false} busy onSend={() => {}} />)
    typeInto('   ')
    expect(screen.queryByText(HINT)).toBeNull()
  })

  it('只读 / 已归档会话不出现(那里有各自的说明)', () => {
    const { rerender } = render(<Composer providers={providers} disabled={false} busy readOnly onSend={() => {}} />)
    expect(screen.queryByText(HINT)).toBeNull()
    rerender(<Composer providers={providers} disabled={false} busy archived onSend={() => {}} />)
    expect(screen.queryByText(HINT)).toBeNull()
  })
})
