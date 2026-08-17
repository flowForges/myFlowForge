import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RunEventCard } from './RunEventCard'
import type { RunEvent } from '../../main/run/events'
import type { FrozenRunCard } from '../views/chat/runCards'

// #7: shorthand for the ordinary-gate props these finalize-gate-only tests never exercise
// (onLane) — mirrors how every other test in this file passes vi.fn() for it, just spread once.
const noopHandlers = { onLane: vi.fn() }

describe('RunEventCard', () => {
  it('renders null when neither event nor frozen is given', () => {
    const { container } = render(<RunEventCard onGate={vi.fn()} onLane={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('gate: renders body + 通过/打回本阶段, and 通过 fires resolveGate advance', () => {
    const onGate = vi.fn()
    // First stage (design) with no earlier stages → 回退到某阶段 is correctly hidden (see the dedicated
    // jumpBack tests below); only 通过/打回本阶段 show here.
    const event: RunEvent = { id: 'g1', kind: 'gate', stageKey: 'design', stageName: '技术方案设计', body: '## 方案\n采用网关架构' }
    render(<RunEventCard event={event} onGate={onGate} onLane={vi.fn()} stages={[{ key: 'design', name: '技术方案设计' }, { key: 'impl', name: '实现' }]} />)

    expect(document.querySelector('.msg-req')?.classList.contains('k-gate')).toBe(true)
    expect(screen.getByText('通过')).toBeInTheDocument()
    expect(screen.getByText('打回本阶段')).toBeInTheDocument()
    expect(screen.queryByText('回退到某阶段')).toBeNull()   // first stage: nothing to roll back to
    // body rendered as markdown
    expect(screen.getByText('方案')).toBeInTheDocument()

    fireEvent.click(screen.getByText('通过'))
    expect(onGate).toHaveBeenCalledWith('g1', { type: 'advance' })
  })

  it('failure: labels the card with its project so two failed lanes are distinguishable, and 重跑 retries that lane', () => {
    const onLane = vi.fn()
    const event: RunEvent = { id: 'f1', kind: 'failure', laneId: 'design:go-blog', stageKey: 'design', error: '探查失败', attempts: 1 }
    render(<RunEventCard event={event} onGate={vi.fn()} onLane={onLane} />)
    expect(screen.getByText('阶段执行失败')).toBeInTheDocument()
    expect(screen.getByText('项目 go-blog')).toBeInTheDocument()   // the fix: which project failed
    fireEvent.click(screen.getByText('重跑'))
    expect(onLane).toHaveBeenCalledWith('f1', { type: 'retry' })
  })

  it('failure: a root (single-scope) lane shows no project chip', () => {
    const event: RunEvent = { id: 'f2', kind: 'failure', laneId: 'design:root', stageKey: 'design', error: 'x', attempts: 1 }
    render(<RunEventCard event={event} onGate={vi.fn()} onLane={vi.fn()} />)
    expect(screen.queryByText(/^项目 /)).toBeNull()
  })

  it('#6 gate: titles the card with stageName (not the generic 阶段评审); falls back when absent', () => {
    const named: RunEvent = { id: 'gN', kind: 'gate', stageKey: 'design', stageName: '技术方案设计', body: 'x' }
    const { rerender } = render(<RunEventCard event={named} onGate={vi.fn()} onLane={vi.fn()} />)
    expect(screen.getByText('技术方案设计')).toBeInTheDocument()
    expect(screen.queryByText('阶段评审')).toBeNull()
    // absent stageName (old/loose event) falls back to 阶段评审
    const bare = { id: 'gB', kind: 'gate', stageKey: 'design', body: 'x' } as unknown as RunEvent
    rerender(<RunEventCard event={bare} onGate={vi.fn()} onLane={vi.fn()} />)
    expect(screen.getByText('阶段评审')).toBeInTheDocument()
  })

  it('#6 frozen gate: keeps its stageName title after reload; defaults to 阶段评审 when the old card lacks it', () => {
    const withName: FrozenRunCard = {
      id: 'fN', kind: 'gate', stageKey: 'design', stageName: '技术方案设计', title: '技术方案已就绪',
      decision: '通过', at: 1720000000000, ts: 1,
    }
    const { rerender } = render(<RunEventCard frozen={withName} onGate={vi.fn()} onLane={vi.fn()} />)
    expect(screen.getByText('技术方案设计')).toBeInTheDocument()
    const legacy: FrozenRunCard = {
      id: 'fL', kind: 'gate', stageKey: 'design', title: '旧卡',
      decision: '通过', at: 1720000000000, ts: 1,
    }
    rerender(<RunEventCard frozen={legacy} onGate={vi.fn()} onLane={vi.fn()} />)
    expect(screen.getByText('阶段评审')).toBeInTheDocument()
  })

  it('gate: docs render a 打开文档 button that maps ArtifactRef → DesignDocRef and calls onOpenDoc', () => {
    const onOpenDoc = vi.fn()
    const event: RunEvent = {
      id: 'g1b', kind: 'gate', stageKey: 'design', stageName: '技术方案设计', body: '## 方案', docs: [{ path: '/ws/.forge/runs/r1/artifacts/design-root.md', kind: 'md' }],
    }
    render(<RunEventCard event={event} onGate={vi.fn()} onLane={vi.fn()} onOpenDoc={onOpenDoc} />)

    const docBtn = document.querySelector('.req-doc') as HTMLElement
    expect(docBtn).toBeTruthy()
    expect(screen.getByText('design-root.md')).toBeInTheDocument()

    fireEvent.click(docBtn)
    expect(onOpenDoc).toHaveBeenCalledWith({ path: '/ws/.forge/runs/r1/artifacts/design-root.md', cwd: '/', name: 'design-root.md' })
  })

  it('gate: no docs → no doc buttons, body still renders', () => {
    const event: RunEvent = { id: 'g1c', kind: 'gate', stageKey: 'design', stageName: '技术方案设计', body: '## 方案\n无文档' }
    render(<RunEventCard event={event} onGate={vi.fn()} onLane={vi.fn()} />)
    expect(document.querySelector('.req-doc')).toBeNull()
    expect(document.querySelector('.req-docs')).toBeNull()
    expect(screen.getByText('方案')).toBeInTheDocument()
  })

  it('frozen gate: docs are preserved and still openable after resolution', () => {
    const onOpenDoc = vi.fn()
    const frozen: FrozenRunCard = {
      id: 'g1d', kind: 'gate', stageKey: 'design', title: '技术方案设计完成',
      decision: '通过', at: 1720000000000, ts: 1,
      docs: [{ path: '/ws/.forge/runs/r1/artifacts/design-root.md', kind: 'md' }],
    }
    render(<RunEventCard frozen={frozen} onGate={vi.fn()} onLane={vi.fn()} onOpenDoc={onOpenDoc} />)
    const docBtn = document.querySelector('.req-doc') as HTMLElement
    expect(docBtn).toBeTruthy()
    fireEvent.click(docBtn)
    expect(onOpenDoc).toHaveBeenCalledWith({ path: '/ws/.forge/runs/r1/artifacts/design-root.md', cwd: '/', name: 'design-root.md' })
  })

  it('gate: 打回本阶段 sends redo with typed feedback', () => {
    const onGate = vi.fn()
    const event: RunEvent = { id: 'g2', kind: 'gate', stageKey: 'design', stageName: '技术方案设计', body: 'x' }
    render(<RunEventCard event={event} onGate={onGate} onLane={vi.fn()} />)
    const fb = screen.getByPlaceholderText(/补充说明（打回\/回退时附带）/)
    fireEvent.change(fb, { target: { value: '再调整一下接口命名' } })
    fireEvent.click(screen.getByText('打回本阶段'))
    expect(onGate).toHaveBeenCalledWith('g2', { type: 'redo', feedback: '再调整一下接口命名' })
  })

  it('gate: 问 AI（不重跑）sends an ask decision with the typed question — no stage re-run', () => {
    const onGate = vi.fn()
    const event: RunEvent = { id: 'g3', kind: 'gate', stageKey: 'design', stageName: '技术方案设计', body: 'x' }
    render(<RunEventCard event={event} onGate={onGate} onLane={vi.fn()} />)
    const fb = screen.getByPlaceholderText(/或在此输入问题/)
    fireEvent.change(fb, { target: { value: '待澄清项3是什么意思' } })
    fireEvent.click(screen.getByText('问 AI（不重跑）'))
    expect(onGate).toHaveBeenCalledWith('g3', { type: 'ask', question: '待澄清项3是什么意思' })
  })

  it('renders an answer event (gate Q&A) as a read-only card showing the question + answer', () => {
    const event: RunEvent = { id: 'a1', kind: 'answer', stageKey: 'design', stageName: '技术方案设计', question: '这是什么意思', body: '意思是……' }
    render(<RunEventCard event={event} onGate={vi.fn()} onLane={vi.fn()} />)
    expect(screen.getByText(/这是什么意思/)).toBeTruthy()
    expect(screen.getByText(/意思是/)).toBeTruthy()
  })

  it('gate: 回退到某阶段 only offers EARLIER stages (not the current one, NOT later ones — that would be a skip) and sends jumpBack with the picked key', () => {
    const onGate = vi.fn()
    const event: RunEvent = { id: 'g3', kind: 'gate', stageKey: 'impl', stageName: '实现', body: 'x' }
    const stages = [{ key: 'design', name: '技术方案设计' }, { key: 'impl', name: '实现' }, { key: 'review', name: '代码 CR' }]
    render(<RunEventCard event={event} onGate={onGate} onLane={vi.fn()} stages={stages} />)
    fireEvent.click(screen.getByText('回退到某阶段'))
    // Only the earlier stage (design) is offered; the current stage (impl) and the LATER stage (review)
    // are both excluded — jumpBack is a rollback, never a skip-forward. Picked by human name.
    expect(screen.getByRole('option', { name: '技术方案设计' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: '实现' })).toBeNull()
    expect(screen.queryByRole('option', { name: '代码 CR' })).toBeNull()   // regression: later stage must NOT appear
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'design' } })
    fireEvent.click(screen.getByText('确认回退'))
    expect(onGate).toHaveBeenCalledWith('g3', { type: 'jumpBack', targetKey: 'design', feedback: undefined })
  })

  it('gate: the 回退到某阶段 control is hidden at the first stage (nothing earlier to roll back to)', () => {
    const event: RunEvent = { id: 'g4', kind: 'gate', stageKey: 'design', stageName: '技术方案设计', body: 'x' }
    const stages = [{ key: 'design', name: '技术方案设计' }, { key: 'impl', name: '实现' }, { key: 'review', name: '代码 CR' }]
    render(<RunEventCard event={event} onGate={vi.fn()} onLane={vi.fn()} stages={stages} />)
    expect(screen.getByText('通过')).toBeInTheDocument()
    expect(screen.queryByText('回退到某阶段')).toBeNull()
  })

  it('auth: renders title+where and 批准/拒绝 route through resolveLane', () => {
    const onLane = vi.fn()
    const event: RunEvent = { id: 'a1', kind: 'auth', laneId: 'l1', stageKey: 'impl', title: '执行 rm -rf tmp/', where: 'apps/web' }
    render(<RunEventCard event={event} onGate={vi.fn()} onLane={onLane} />)

    expect(screen.getByText('执行 rm -rf tmp/ · apps/web')).toBeInTheDocument()
    fireEvent.click(screen.getByText('批准'))
    expect(onLane).toHaveBeenCalledWith('a1', { type: 'authorize' })
    fireEvent.click(screen.getByText('拒绝'))
    expect(onLane).toHaveBeenCalledWith('a1', { type: 'deny' })
  })

  // 阶段代理也会【问人】(claude AskUserQuestion 借权限通道发出来)。这种 auth 事件带 questions,必须画成
  // 可点的选项 —— 走 批准/拒绝 的话「批准」什么也没答,代理只会收到「用户没有回答」。
  it('auth 带 questions:画出选项而不是批准/拒绝,选择随 answerQuestions 回传', () => {
    const onLane = vi.fn()
    const event: RunEvent = {
      id: 'a2', kind: 'auth', laneId: 'l1', stageKey: 'design', title: '配置文件用哪种格式？',
      questions: [{ question: '配置文件用哪种格式？', header: '配置格式', multiSelect: false, options: [
        { label: 'JSON', description: '通用性最好' },
        { label: 'TOML', description: '语法清晰' },
      ] }],
    }
    const { container } = render(<RunEventCard event={event} onGate={vi.fn()} onLane={onLane} />)

    expect(container.querySelectorAll('.req-opt')).toHaveLength(2)
    expect(screen.getByText('语法清晰')).toBeInTheDocument()
    // 「批准」不该再出现 —— 它正是那个点了等于没答的按钮。
    expect(screen.queryByText('批准')).toBeNull()

    fireEvent.click(screen.getByText('TOML'))
    expect(onLane).toHaveBeenCalledWith('a2', { type: 'answerQuestions', answers: { '配置文件用哪种格式？': ['TOML'] }, response: undefined })
  })

  it('auth 带 questions:选项都不合适时可以直接打字,「拒绝」仍走 deny', () => {
    const onLane = vi.fn()
    const event: RunEvent = {
      id: 'a3', kind: 'auth', laneId: 'l1', stageKey: 'design', title: '选哪个？',
      questions: [{ question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }],
    }
    render(<RunEventCard event={event} onGate={vi.fn()} onLane={onLane} />)

    fireEvent.change(screen.getByPlaceholderText('以上都不合适？直接输入你的回答…'), { target: { value: '都不行' } })
    fireEvent.click(screen.getByText('提交'))
    expect(onLane).toHaveBeenCalledWith('a3', { type: 'answerQuestions', answers: {}, response: '都不行' })

    fireEvent.click(screen.getByText('拒绝'))
    expect(onLane).toHaveBeenCalledWith('a3', { type: 'deny' })
  })

  it('failure: renders error+attempts and 重跑/跳过 route through resolveLane', () => {
    const onLane = vi.fn()
    const event: RunEvent = { id: 'f1', kind: 'failure', laneId: 'l2', stageKey: 'impl', error: '构建失败', attempts: 2 }
    render(<RunEventCard event={event} onGate={vi.fn()} onLane={onLane} />)

    expect(screen.getByText('构建失败（已重试 2 次）')).toBeInTheDocument()
    fireEvent.click(screen.getByText('重跑'))
    expect(onLane).toHaveBeenCalledWith('f1', { type: 'retry' })
    fireEvent.click(screen.getByText('跳过'))
    expect(onLane).toHaveBeenCalledWith('f1', { type: 'skipLane' })
  })

  it('doubt: renders note + FOUR actions; 回退改方案→jumpBack, 驳回继续→dismiss', () => {
    const onLane = vi.fn()
    const event: RunEvent = { id: 'd1', kind: 'doubt', laneId: 'l3', stageKey: 'impl', note: '这个方案好像漏了鉴权' }
    render(<RunEventCard event={event} onGate={vi.fn()} onLane={onLane} />)

    expect(document.querySelector('.msg-req')?.classList.contains('k-doubt')).toBe(true)
    expect(document.querySelector('.msg-req')?.classList.contains('k-confirm')).toBe(false)
    expect(screen.getByText('这个方案好像漏了鉴权')).toBeInTheDocument()
    expect(screen.getByText('回退改方案')).toBeInTheDocument()
    expect(screen.getByText('驳回继续')).toBeInTheDocument()
    expect(screen.getByText('补充说明后继续')).toBeInTheDocument()
    expect(screen.getByText('终止运行')).toBeInTheDocument()

    fireEvent.click(screen.getByText('回退改方案'))
    expect(onLane).toHaveBeenCalledWith('d1', { type: 'jumpBack' })

    fireEvent.click(screen.getByText('驳回继续'))
    expect(onLane).toHaveBeenCalledWith('d1', { type: 'dismiss' })
  })

  it('doubt: 补充说明后继续 sends redo with typed feedback, 终止运行 sends abort', () => {
    const onLane = vi.fn()
    const event: RunEvent = { id: 'd2', kind: 'doubt', laneId: 'l4', stageKey: 'impl', note: '存疑' }
    render(<RunEventCard event={event} onGate={vi.fn()} onLane={onLane} />)
    const fb = screen.getByPlaceholderText('补充说明（继续时可选附带）')
    fireEvent.change(fb, { target: { value: '已确认鉴权在网关层做' } })
    fireEvent.click(screen.getByText('补充说明后继续'))
    expect(onLane).toHaveBeenCalledWith('d2', { type: 'redo', feedback: '已确认鉴权在网关层做' })

    fireEvent.click(screen.getByText('终止运行'))
    expect(onLane).toHaveBeenCalledWith('d2', { type: 'abort' })
  })

  it('question: renders title + a multi-line textarea (not a single-line input), submits answer', () => {
    const onLane = vi.fn()
    const event: RunEvent = { id: 'q1', kind: 'question', laneId: 'l5', stageKey: 'impl', title: '用哪个目录名？', placeholder: 'src/foo' }
    render(<RunEventCard event={event} onGate={vi.fn()} onLane={onLane} />)
    const input = screen.getByPlaceholderText('src/foo')
    // The answer can be a long requirement description — this must be a <textarea>, not a
    // single-line <input>, so the user can see/edit multi-line text (see task's Fix 1).
    expect(input.tagName).toBe('TEXTAREA')
    fireEvent.change(input, { target: { value: 'src/bar' } })
    fireEvent.click(screen.getByText('提交'))
    expect(onLane).toHaveBeenCalledWith('q1', { type: 'answer', value: 'src/bar' })
  })

  // #7: no targetBranch/tempBranch on this event (an older/looser one) — the merge button falls
  // back to its generic '合并并完成' label (see RunEventCard's `event.targetBranch ? … : '合并并完成'`),
  // and 彻底丢弃 now needs its two-click confirm (see the dedicated 收尾门三按钮 describe below for the
  // real-branch-name path).
  it('finalize gate: renders 收尾确认 body + 合并并完成/彻底丢弃, both route through onGate with merge/discard', () => {
    const onGate = vi.fn()
    const event: RunEvent = { id: 'fz1', kind: 'gate', stageKey: '__finalize__', stageName: '收尾确认', body: '全部完成，合并到目标分支？', finalize: true }
    render(<RunEventCard event={event} onGate={onGate} onLane={vi.fn()} />)

    expect(document.querySelector('.msg-req')?.classList.contains('k-gate')).toBe(true)
    expect(screen.getByText('收尾确认')).toBeInTheDocument()
    expect(screen.getByText('全部完成，合并到目标分支？')).toBeInTheDocument()
    // the ordinary gate's actions must NOT be present on a finalize card
    expect(screen.queryByText('通过')).not.toBeInTheDocument()
    expect(screen.queryByText('打回本阶段')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('合并并完成'))
    expect(onGate).toHaveBeenCalledWith('fz1', { type: 'merge' })
    fireEvent.click(screen.getByText(/彻底丢弃这次改动/))
    expect(onGate).not.toHaveBeenCalledWith('fz1', { type: 'discard' })
    fireEvent.click(screen.getByText('确认丢弃'))
    expect(onGate).toHaveBeenCalledWith('fz1', { type: 'discard' })
  })

  it('frozen finalize gate: labels 收尾确认 (not 阶段评审) and shows the decision, no buttons', () => {
    const frozen: FrozenRunCard = {
      id: 'fz1', kind: 'gate', stageKey: '__finalize__', title: '全部完成，合并到目标分支？',
      decision: '合并并完成', at: 1720000000000, ts: 1, finalize: true,
    }
    const { container } = render(<RunEventCard frozen={frozen} onGate={vi.fn()} onLane={vi.fn()} />)
    expect(screen.getByText('收尾确认')).toBeInTheDocument()
    expect(screen.getByText('决定：合并并完成')).toBeInTheDocument()
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('①汇总: frozen summary card labels 本次运行总结, renders body as markdown, NO 决定 line / buttons', () => {
    const frozen: FrozenRunCard = {
      id: 'summary-r1', kind: 'summary', stageKey: '__summary__', title: '',
      body: '## 本次改动\n- 项目A 改了 x', decision: '', at: 1720000000000, ts: 1,
    }
    const { container } = render(<RunEventCard frozen={frozen} onGate={vi.fn()} onLane={vi.fn()} />)
    expect(screen.getByText('本次运行总结')).toBeInTheDocument()
    // body rendered as markdown (heading text present, not the raw "##")
    expect(screen.getByText('本次改动')).toBeInTheDocument()
    // a summary card records nothing the user decided
    expect(screen.queryByText(/决定：/)).toBeNull()
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.querySelector('.msg-req')?.classList.contains('k-summary')).toBe(true)
  })

  it('hook: frozen hook card labels 插件 · HOOK, shows the hook name (title) + output (body), no 决定 line / buttons', () => {
    const frozen: FrozenRunCard = {
      id: 'hook-r1-hook:t', kind: 'hook', stageKey: 'hook:t', title: '当前时间',
      body: '当前系统日期与时间：`2026-08-02T16:05:36+08:00`', decision: '', at: 1720000000000, ts: 1,
    }
    const { container } = render(<RunEventCard frozen={frozen} onGate={vi.fn()} onLane={vi.fn()} />)
    expect(screen.getByText('插件 · HOOK')).toBeInTheDocument()
    expect(screen.getByText('当前时间')).toBeInTheDocument()          // hook name (title)
    expect(screen.getByText(/当前系统日期与时间/)).toBeInTheDocument() // output (body) in the conversation
    expect(screen.queryByText(/决定：/)).toBeNull()
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.querySelector('.msg-req')?.classList.contains('k-hook')).toBe(true)
  })

  it('frozen: renders decision record with NO buttons', () => {
    const frozen: FrozenRunCard = {
      id: 'g1', kind: 'gate', stageKey: 'design', title: '技术方案设计完成',
      decision: '通过', at: 1720000000000, ts: 1,
    }
    const { container } = render(<RunEventCard frozen={frozen} onGate={vi.fn()} onLane={vi.fn()} />)
    expect(screen.getByText('技术方案设计完成')).toBeInTheDocument()
    expect(screen.getByText('决定：通过')).toBeInTheDocument()
    expect(container.querySelectorAll('button')).toHaveLength(0)
    const card = container.querySelector('.msg-req')
    expect(card?.classList.contains('k-gate')).toBe(true)
    expect(card?.classList.contains('done')).toBe(true)
  })
})

describe('收尾门三按钮', () => {
  const gate = {
    id: 'g1', kind: 'gate' as const, stageKey: '__finalize__', stageName: '收尾确认',
    body: '总结', finalize: true, targetBranch: 'branch1', tempBranch: 'forge/run-a1b2',
  }

  it('主按钮显示真实目标分支名', () => {
    render(<RunEventCard event={gate} onGate={() => {}} {...noopHandlers} />)
    expect(screen.getByText('合并到 branch1')).toBeTruthy()
  })

  it('「先不合并」发 park，且文案点名保留的分支', () => {
    const onGate = vi.fn()
    render(<RunEventCard event={gate} onGate={onGate} {...noopHandlers} />)
    fireEvent.click(screen.getByText(/先不合并/))
    expect(onGate).toHaveBeenCalledWith('g1', { type: 'park' })
  })

  it('「彻底丢弃」第一次点击只展开确认，不发 discard', () => {
    const onGate = vi.fn()
    render(<RunEventCard event={gate} onGate={onGate} {...noopHandlers} />)
    fireEvent.click(screen.getByText(/彻底丢弃这次改动/))
    expect(onGate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('确认丢弃'))
    expect(onGate).toHaveBeenCalledWith('g1', { type: 'discard' })
  })
})
