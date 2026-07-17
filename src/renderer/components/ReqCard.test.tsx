import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ReqCard } from './ReqCard'
import type { PendingAction, ResolvePayload } from '@shared/types'

const base = { agentId: 'a1', agentName: 'Refactor', wsName: 'ws', provider: 'claude', role: '重构 tokens.css' }

describe('ReqCard', () => {
  it('renders a confirm card with provider pdot + label, and fires allow on 允许并继续', () => {
    const onResolve = vi.fn<(p: ResolvePayload) => void>()
    const action: PendingAction = { ...base, id: 'p1', kind: 'confirm', title: '覆盖文件?' }
    const { container } = render(<ReqCard action={action} onResolve={onResolve} />)

    expect(container.querySelector('.msg-req.k-confirm')).toBeTruthy()
    expect(container.querySelector('.req-from .pdot.p-claude')).toBeTruthy()
    expect(screen.getByText('需确认')).toBeInTheDocument()
    expect(screen.getByText('Refactor')).toBeInTheDocument()

    fireEvent.click(screen.getByText('允许并继续'))
    expect(onResolve).toHaveBeenCalledWith({ id: 'p1', decision: 'allow' })

    fireEvent.click(screen.getByText('拒绝'))
    expect(onResolve).toHaveBeenCalledWith({ id: 'p1', decision: 'deny' })
  })

  it('a NON-reworkable confirm has no 打回重做 button (forge_ask confirm)', () => {
    const onResolve = vi.fn<(p: ResolvePayload) => void>()
    const action: PendingAction = { ...base, id: 'p1b', kind: 'confirm', title: '覆盖文件?' }
    render(<ReqCard action={action} onResolve={onResolve} />)
    expect(screen.queryByText('打回重做…')).toBeNull()
    expect(screen.getByText('拒绝')).toBeInTheDocument()
  })

  it('a reworkable stage gate shows 终止 wording + a 打回重做 button that calls onSupplement (no inline textarea)', () => {
    const onResolve = vi.fn<(p: ResolvePayload) => void>()
    const onSupplement = vi.fn()
    const action: PendingAction = { ...base, id: 'pg', kind: 'confirm', title: '技术方案设计完成', role: '阶段评审', reworkable: true }
    render(<ReqCard action={action} onResolve={onResolve} onSupplement={onSupplement} />)

    // 终止 wording (not 拒绝) + a 打回重做 button
    expect(screen.getByText('终止')).toBeInTheDocument()
    fireEvent.click(screen.getByText('打回重做…'))
    expect(onSupplement).toHaveBeenCalledTimes(1)
    // No inline modify textarea remains — the supplement reflows to the main composer instead (Task 16).
    expect(screen.queryByPlaceholderText(/修改方向/)).toBeNull()
    expect(onResolve).not.toHaveBeenCalled()

    // allow/deny (终止) still resolve directly, unaffected.
    fireEvent.click(screen.getByText('终止'))
    expect(onResolve).toHaveBeenCalledWith({ id: 'pg', decision: 'deny' })
  })

  it('renders an input card and submits the typed value', () => {
    const onResolve = vi.fn<(p: ResolvePayload) => void>()
    const action: PendingAction = { ...base, id: 'p2', kind: 'input', title: '快照目录', placeholder: 'tests/visual' }
    render(<ReqCard action={action} onResolve={onResolve} />)

    const input = screen.getByPlaceholderText('tests/visual') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'tests/snap' } })
    fireEvent.click(screen.getByText('提交'))
    expect(onResolve).toHaveBeenCalledWith({ id: 'p2', decision: 'allow', value: 'tests/snap' })
  })

  it('renders a select card and fires choice index on option click', () => {
    const onResolve = vi.fn<(p: ResolvePayload) => void>()
    const action: PendingAction = {
      ...base, id: 'p3', kind: 'select', title: '选择策略',
      options: [{ t: '逐文件迁移', d: '分批' }, { t: '全量替换', d: '最快' }],
    }
    render(<ReqCard action={action} onResolve={onResolve} />)

    expect(screen.getByText('需选择')).toBeInTheDocument()
    expect(screen.getByText('逐文件迁移')).toBeInTheDocument()
    fireEvent.click(screen.getByText('全量替换'))
    expect(onResolve).toHaveBeenCalledWith({ id: 'p3', decision: 'allow', choice: 1 })
  })

  it('a select card also lets the user type a custom answer (sent as value, no choice)', () => {
    const onResolve = vi.fn<(p: ResolvePayload) => void>()
    const action: PendingAction = {
      ...base, id: 'p3c', kind: 'select', title: '选择策略',
      options: [{ t: '逐文件迁移', d: '分批' }, { t: '全量替换', d: '最快' }],
    }
    render(<ReqCard action={action} onResolve={onResolve} />)

    const custom = screen.getByPlaceholderText(/以上都不合适/) as HTMLInputElement
    // Empty → submit disabled (no accidental blank answer).
    const submit = custom.closest('.req-inrow')!.querySelector('button') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(custom, { target: { value: '  按调用频率热点优先迁移  ' } })
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    // Trimmed value, and NO choice index — the sub-agent receives the free text verbatim.
    expect(onResolve).toHaveBeenCalledWith({ id: 'p3c', decision: 'allow', value: '按调用频率热点优先迁移' })
    expect(onResolve).not.toHaveBeenCalledWith(expect.objectContaining({ choice: expect.anything() }))
  })

  it('a select card submits the custom answer on Enter', () => {
    const onResolve = vi.fn<(p: ResolvePayload) => void>()
    const action: PendingAction = {
      ...base, id: 'p3e', kind: 'select', title: '选择策略',
      options: [{ t: 'A', d: 'a' }],
    }
    render(<ReqCard action={action} onResolve={onResolve} />)
    const custom = screen.getByPlaceholderText(/以上都不合适/) as HTMLInputElement
    fireEvent.change(custom, { target: { value: '我的自定义意见' } })
    fireEvent.keyDown(custom, { key: 'Enter' })
    expect(onResolve).toHaveBeenCalledWith({ id: 'p3e', decision: 'allow', value: '我的自定义意见' })
  })

  it('escapes untrusted html in title/sub (no XSS) — renders as literal text', () => {
    const action: PendingAction = {
      ...base, id: 'p4', kind: 'confirm',
      title: '<img src=x onerror="alert(1)">', sub: '存在 <b>未提交修改</b>',
    }
    const { container } = render(<ReqCard action={action} onResolve={() => {}} />)
    // No DOM nodes were created from the injected markup.
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.req-sub b')).toBeNull()
    // The markup is present verbatim as text content.
    expect(container.querySelector('.req-title')?.textContent).toBe('<img src=x onerror="alert(1)">')
    expect(container.querySelector('.req-sub')?.textContent).toBe('存在 <b>未提交修改</b>')
  })

  it('renders a confirm body as markdown (the technical plan under review at a gate)', () => {
    const action: PendingAction = {
      ...base, id: 'p6', kind: 'confirm',
      title: '技术方案设计完成 — 审阅后批准继续开发',
      body: '## 方案\n采用 **网关** 架构,分三步实施。',
    }
    const { container } = render(<ReqCard action={action} onResolve={() => {}} />)
    const plan = container.querySelector('.req-plan')
    expect(plan).toBeTruthy()
    expect(plan?.textContent).toContain('采用')
    // Markdown is rendered (heading + bold), not shown as literal '##'/'**'
    expect(plan?.querySelector('h2')?.textContent).toBe('方案')
    expect(plan?.querySelector('strong')?.textContent).toBe('网关')
  })

  it('renders a 打开文档 button per design doc and fires onOpenDoc with that doc', () => {
    const onOpenDoc = vi.fn()
    const docs = [
      { path: 'docs/技术方案-go.md', cwd: '/ws/go', name: 'go-blog' },
      { path: '技术方案-总览.md', cwd: '/ws', name: '主代理' },
    ]
    const action: PendingAction = {
      ...base, id: 'p8', kind: 'confirm', title: '技术方案设计完成', body: '# 总方案', docs,
    }
    const { container } = render(<ReqCard action={action} onResolve={() => {}} onOpenDoc={onOpenDoc} />)
    const btns = container.querySelectorAll('.req-doc')
    expect(btns).toHaveLength(2)
    expect(container.textContent).toContain('技术方案-go.md') // shows the file name
    fireEvent.click(btns[0])
    expect(onOpenDoc).toHaveBeenCalledWith(docs[0])
  })

  it('renders no doc buttons when a confirm has no docs', () => {
    const action: PendingAction = { ...base, id: 'p9', kind: 'confirm', title: 't', body: '# x' }
    const { container } = render(<ReqCard action={action} onResolve={() => {}} />)
    expect(container.querySelector('.req-doc')).toBeNull()
  })

  it('confirm+docs 显示完整路径,并有独立复制控件(不触发打开)', () => {
    const onResolve = vi.fn()
    const onOpenDoc = vi.fn()
    const writeText = vi.fn()
    Object.assign(navigator, { clipboard: { writeText } })
    const action: any = { ...base, id: 'p9', kind: 'confirm', title: '技术方案设计完成',
      docs: [{ path: 'docs/plan/方案-总览.md', cwd: '/ws', name: '总览' }] }
    const { container } = render(<ReqCard action={action} onResolve={onResolve} onOpenDoc={onOpenDoc} />)
    // 完整路径可见
    expect(screen.getByText('docs/plan/方案-总览.md')).toBeInTheDocument()
    // 复制控件:点击写剪贴板,且不触发打开
    const copy = container.querySelector('.req-doc-copy') as HTMLElement
    expect(copy).toBeTruthy()
    fireEvent.click(copy)
    expect(writeText).toHaveBeenCalledWith('docs/plan/方案-总览.md')
    expect(onOpenDoc).not.toHaveBeenCalled()
    // 点文档主体触发打开
    fireEvent.click(screen.getByText('总览'))
    expect(onOpenDoc).toHaveBeenCalled()
  })

  it('renders no .req-plan when a confirm has no body', () => {
    const action: PendingAction = { ...base, id: 'p7', kind: 'confirm', title: '覆盖文件?' }
    const { container } = render(<ReqCard action={action} onResolve={() => {}} />)
    expect(container.querySelector('.req-plan')).toBeNull()
  })

  it('renders confirm where as a .req-file path', () => {
    const action: PendingAction = {
      ...base, id: 'p5', kind: 'confirm', title: '覆盖文件?', where: 'src/styles/tokens.css',
    }
    const { container } = render(<ReqCard action={action} onResolve={() => {}} />)
    const file = container.querySelector('.req-sub .req-file')
    expect(file).toBeTruthy()
    expect(file?.textContent).toBe('src/styles/tokens.css')
  })
})
