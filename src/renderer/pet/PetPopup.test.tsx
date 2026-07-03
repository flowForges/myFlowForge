import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PetPopup } from './PetPopup'
import type { PopupData } from './derivePopupData'
import type { ChatSession, SessionsFile } from '@shared/types'

const data: PopupData = {
  statusText: '1 项待处理 · 1 个代理在执行',
  badge: { count: 1, warn: true },
  pending: [{ id: 'p1', kind: 'confirm', agentId: 'a', agentName: 'Refactor 代理', wsName: 'ds', title: '覆盖 theme.ts', where: 'theme.ts' }],
  workspaces: [{ name: 'ds', path: '/ds', sub: '2 个项目 · standard', status: 'run', agents: ['设计代理'], done: false }],
  activeAgents: [{ name: '设计代理', role: '技术方案设计', stage: '设计' }],
}

describe('PetPopup', () => {
  it('renders head status, the pending section and the workspace section', () => {
    const { container } = render(<PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}} />)
    expect(container.querySelector('.pet-pop.open')).not.toBeNull()
    expect(container.querySelector('.pet-pop')!.getAttribute('data-corner')).toBe('right')
    expect(container.querySelector('.st')!.textContent).toBe('1 项待处理 · 1 个代理在执行')
    expect(screen.getByText('待你处理')).toBeInTheDocument()
    expect(container.querySelector('.pp-act')).not.toBeNull()
    expect(screen.getByText('工作区 · 1')).toBeInTheDocument()
    expect(container.querySelector('.pp-ws')).not.toBeNull()
  })

  it('shows the currently-executing agents section (name · role · stage)', () => {
    const { container } = render(<PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}} />)
    expect(screen.getByText('当前执行 · 1 个代理')).toBeInTheDocument()
    const row = container.querySelector('.pp-agent')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('设计代理')
    expect(row!.textContent).toContain('设计')
  })

  it('omits the pending section when there is nothing pending and shows empty workspaces', () => {
    const empty: PopupData = { statusText: '看守 0 个工作区 · 全部空闲', badge: null, pending: [], workspaces: [], activeAgents: [] }
    const { container } = render(<PetPopup open={false} corner="left" data={empty} onResolve={() => {}} onGo={() => {}} onClose={() => {}} />)
    expect(container.querySelector('.pet-pop.open')).toBeNull()
    expect(screen.queryByText('待你处理')).toBeNull()
    expect(container.querySelector('.pp-empty')).not.toBeNull()
  })

  it('fires onClose from the close button', () => {
    const onClose = vi.fn()
    const { container } = render(<PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={onClose} />)
    fireEvent.click(container.querySelector('.pp-x')!)
    expect(onClose).toHaveBeenCalled()
  })

  it('renders the quick-command input + 发送 and the shared queue, wiring send/cancel', () => {
    const onSendCmd = vi.fn(); const onCancelCmd = vi.fn()
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        currentWs="/w" queue={[{ id: 'q1', text: '做X', source: '宠物' }]} onSendCmd={onSendCmd} onCancelCmd={onCancelCmd} />
    )
    expect(screen.getByText('向当前工作区下达指令')).toBeInTheDocument()
    const input = container.querySelector('.pp-send input') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.disabled).toBe(false)
    expect(screen.getByText('发送')).toBeInTheDocument()
    // queue section header + item
    expect(screen.getByText('指令队列 · 1 · 排队中')).toBeInTheDocument()
    const item = container.querySelector('.pp-q')!
    expect(item.querySelector('.qt')!.textContent).toBe('做X')
    expect(item.querySelector('.qsrc')!.textContent).toBe('宠物')
    // send: type then click 发送
    fireEvent.change(input, { target: { value: '  开工  ' } })
    fireEvent.click(screen.getByText('发送'))
    expect(onSendCmd).toHaveBeenCalledWith('开工')
    expect(input.value).toBe('')
    // cancel
    fireEvent.click(item.querySelector('.qx')!)
    expect(onCancelCmd).toHaveBeenCalledWith('q1')
  })

  it('sends on Enter as well', () => {
    const onSendCmd = vi.fn()
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        currentWs="/w" queue={[]} onSendCmd={onSendCmd} onCancelCmd={() => {}} />
    )
    const input = container.querySelector('.pp-send input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'go' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSendCmd).toHaveBeenCalledWith('go')
  })

  it('hides the queue header when the queue is empty and disables input without a current workspace', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        currentWs="" queue={[]} onSendCmd={() => {}} onCancelCmd={() => {}} />
    )
    expect(screen.queryByText(/指令队列/)).toBeNull()
    expect((container.querySelector('.pp-send input') as HTMLInputElement).disabled).toBe(true)
  })

  it('omits the qsrc badge when source is 你', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        currentWs="/w" queue={[{ id: 'q1', text: 't', source: '你' }]} onSendCmd={() => {}} onCancelCmd={() => {}} />
    )
    expect(container.querySelector('.pp-q .qsrc')).toBeNull()
  })
})

// ── Task 7 tests: pp-target + pp-sessbar + pp-send routing ──────────────────

const sess1: ChatSession = { id: 's1', title: '对话 1', mode: 'chat', createdAt: 1000 }
const sess2: ChatSession = { id: 's2', title: '工作流 1', mode: 'workflow', createdAt: 2000 }

const tgt = {
  wsPath: '/ws/proj',
  ws: { name: 'my-project', status: 'idle' as string, activeSessionId: 's1' },
  sess: sess1,
}

describe('PetPopup – pp-target footer (Task 7)', () => {
  it('pp-target shows ws name, sess title, and mode label', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={tgt} sessionsForTarget={[sess1, sess2]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={() => {}} />
    )
    const target = container.querySelector('.pp-target')
    expect(target).not.toBeNull()
    expect(target!.querySelector('.tg-ws')!.textContent).toBe('my-project')
    expect(target!.querySelector('.tg-sess')!.textContent).toBe('对话 1')
    expect(target!.querySelector('.tg-mode')!.textContent).toBe('对话')
  })

  it('pp-sessbar renders a .ps-chip per session; selected chip has .on', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={tgt} sessionsForTarget={[sess1, sess2]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={() => {}} />
    )
    const chips = container.querySelectorAll('.pp-sessbar .ps-chip')
    expect(chips.length).toBe(2)
    expect(chips[0].classList.contains('on')).toBe(true)   // sess1 is selected
    expect(chips[1].classList.contains('on')).toBe(false)
  })

  it('clicking a .ps-chip calls onPickSess(wsPath, sessId)', () => {
    const onPickSess = vi.fn()
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={tgt} sessionsForTarget={[sess1, sess2]} onPickSess={onPickSess} onOpenPicker={() => {}} onJump={() => {}} />
    )
    const chips = container.querySelectorAll('.pp-sessbar .ps-chip')
    fireEvent.click(chips[1])
    expect(onPickSess).toHaveBeenCalledWith('/ws/proj', 's2')
  })

  it('pp-send: typing and clicking 发送 calls onSendCmd and clears the input', () => {
    const onSendCmd = vi.fn()
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={tgt} sessionsForTarget={[sess1, sess2]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={() => {}}
        onSendCmd={onSendCmd} />
    )
    const input = container.querySelector('.pp-send input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  重构  ' } })
    fireEvent.click(screen.getByText('发送'))
    expect(onSendCmd).toHaveBeenCalledWith('重构')
    expect(input.value).toBe('')
  })

  it('clicking .tg-jump calls onJump()', () => {
    const onJump = vi.fn()
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={tgt} sessionsForTarget={[sess1, sess2]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={onJump} />
    )
    fireEvent.click(container.querySelector('.tg-jump')!)
    expect(onJump).toHaveBeenCalled()
  })

  it('clicking .tg-pick calls onOpenPicker()', () => {
    const onOpenPicker = vi.fn()
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={tgt} sessionsForTarget={[sess1, sess2]} onPickSess={() => {}} onOpenPicker={onOpenPicker} onJump={() => {}} />
    )
    fireEvent.click(container.querySelector('.tg-pick')!)
    expect(onOpenPicker).toHaveBeenCalled()
  })

  it('clicking .ps-more calls onOpenPicker()', () => {
    const onOpenPicker = vi.fn()
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={tgt} sessionsForTarget={[sess1, sess2]} onPickSess={() => {}} onOpenPicker={onOpenPicker} onJump={() => {}} />
    )
    fireEvent.click(container.querySelector('.ps-more')!)
    expect(onOpenPicker).toHaveBeenCalled()
  })

  it('mode label shows 工作流 for workflow sessions', () => {
    const tgtWorkflow = { ...tgt, sess: sess2 }
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={tgtWorkflow} sessionsForTarget={[sess1, sess2]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={() => {}} />
    )
    expect(container.querySelector('.tg-mode')!.textContent).toBe('工作流')
  })

  // I1: pp-target .pd status dot modifier class
  it('pp-target .pd has .idle class when ws status is idle', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={{ ...tgt, ws: { ...tgt.ws!, status: 'idle' } }}
        sessionsForTarget={[sess1, sess2]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={() => {}} />
    )
    const pd = container.querySelector('.pp-target .pd')
    expect(pd).not.toBeNull()
    expect(pd!.classList.contains('idle')).toBe(true)
  })

  it('pp-target .pd has .run class when ws status is run', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={{ ...tgt, ws: { ...tgt.ws!, status: 'run' } }}
        sessionsForTarget={[sess1, sess2]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={() => {}} />
    )
    const pd = container.querySelector('.pp-target .pd')
    expect(pd).not.toBeNull()
    expect(pd!.classList.contains('run')).toBe(true)
    expect(pd!.classList.contains('idle')).toBe(false)
  })

  it('pp-target .pd has .ok class when ws status is ok', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={{ ...tgt, ws: { ...tgt.ws!, status: 'ok' } }}
        sessionsForTarget={[sess1, sess2]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={() => {}} />
    )
    const pd = container.querySelector('.pp-target .pd')
    expect(pd!.classList.contains('ok')).toBe(true)
  })

  it('pp-target .pd defaults to .idle when ws status is err or undefined', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={{ ...tgt, ws: { ...tgt.ws!, status: 'err' } }}
        sessionsForTarget={[sess1, sess2]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={() => {}} />
    )
    const pd = container.querySelector('.pp-target .pd')
    expect(pd!.classList.contains('idle')).toBe(true)
  })

  // M1: sessbar chip .sd.run for active+running session
  it('sessbar active+running session chip has .sd.run', () => {
    // sess1 is activeSessionId, tgtWsRunning=true → sess1 chip should have .sd.run
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={{ ...tgt, ws: { ...tgt.ws!, status: 'run', activeSessionId: 's1' } }}
        sessionsForTarget={[sess1, sess2]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={() => {}}
        tgtWsRunning={true} />
    )
    const chips = container.querySelectorAll('.pp-sessbar .ps-chip')
    // chip[0] = sess1 (active + running) → .sd.run
    expect(chips[0].querySelector('.sd')!.classList.contains('run')).toBe(true)
    // chip[1] = sess2 (not active running) → .sd.workflow (its mode)
    expect(chips[1].querySelector('.sd')!.classList.contains('workflow')).toBe(true)
    expect(chips[1].querySelector('.sd')!.classList.contains('run')).toBe(false)
  })

  it('sessbar chip does NOT get .sd.run when workspace is not running', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={{ ...tgt, ws: { ...tgt.ws!, status: 'idle', activeSessionId: 's1' } }}
        sessionsForTarget={[sess1, sess2]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={() => {}}
        tgtWsRunning={false} />
    )
    const chips = container.querySelectorAll('.pp-sessbar .ps-chip')
    // even active chip, not running → uses session mode
    expect(chips[0].querySelector('.sd')!.classList.contains('run')).toBe(false)
    expect(chips[0].querySelector('.sd')!.classList.contains('chat')).toBe(true)
  })
})

// ── Task 8 tests: picker drawer (petView='pick') ─────────────────────────────

const sessA: ChatSession = { id: 'sA', title: '对话 A', mode: 'chat', createdAt: 1000 }
const sessB: ChatSession = { id: 'sB', title: '对话 B', mode: 'workflow', createdAt: 2000 }
const sessC: ChatSession = { id: 'sC', title: '对话 C', mode: 'chat', createdAt: 3000 }

const sfWs1: SessionsFile = { sessions: [sessA, sessB], activeSessionId: 'sA' }
const sfWs2: SessionsFile = { sessions: [sessC], activeSessionId: 'sC' }

const sessionsByWs: Record<string, SessionsFile> = {
  '/ws/alpha': sfWs1,
  '/ws/beta': sfWs2,
}

const tgtPicker = {
  wsPath: '/ws/alpha',
  ws: { name: 'Alpha', status: 'run' as string, activeSessionId: 'sA' },
  sess: sessA,
}

describe('PetPopup – picker drawer (Task 8)', () => {
  it('petView=pick renders .pk-ws groups and .pk-sess rows for all workspaces', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={tgtPicker} sessionsForTarget={[sessA, sessB]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={() => {}}
        petView="pick" sessionsByWs={sessionsByWs} onPickerBack={() => {}} />
    )
    const pkWs = container.querySelectorAll('.pk-ws')
    expect(pkWs.length).toBeGreaterThanOrEqual(2)
    const pkSess = container.querySelectorAll('.pk-sess')
    expect(pkSess.length).toBe(3) // 2 sessions in alpha + 1 in beta
  })

  it('petView=pick hides the footer (.pp-send absent)', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={tgtPicker} sessionsForTarget={[sessA, sessB]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={() => {}}
        petView="pick" sessionsByWs={sessionsByWs} onPickerBack={() => {}} />
    )
    expect(container.querySelector('.pp-send')).toBeNull()
  })

  it('petView=pick renders .pp-back button', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={tgtPicker} sessionsForTarget={[sessA, sessB]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={() => {}}
        petView="pick" sessionsByWs={sessionsByWs} onPickerBack={() => {}} />
    )
    expect(container.querySelector('.pp-back')).not.toBeNull()
    expect(container.querySelector('.pp-pickhint')).not.toBeNull()
  })

  it('.pp-back calls onPickerBack', () => {
    const onPickerBack = vi.fn()
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={tgtPicker} sessionsForTarget={[sessA, sessB]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={() => {}}
        petView="pick" sessionsByWs={sessionsByWs} onPickerBack={onPickerBack} />
    )
    fireEvent.click(container.querySelector('.pp-back')!)
    expect(onPickerBack).toHaveBeenCalled()
  })

  it('clicking .pk-sess calls onPickSess(wsPath, sessId)', () => {
    const onPickSess = vi.fn()
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={tgtPicker} sessionsForTarget={[sessA, sessB]} onPickSess={onPickSess} onOpenPicker={() => {}} onJump={() => {}}
        petView="pick" sessionsByWs={sessionsByWs} onPickerBack={() => {}} />
    )
    const sessions = container.querySelectorAll('.pk-sess')
    // click sessB (/ws/alpha, sB)
    fireEvent.click(sessions[1])
    expect(onPickSess).toHaveBeenCalledWith('/ws/alpha', 'sB')
  })

  it('selected .pk-sess has .on class', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={tgtPicker} sessionsForTarget={[sessA, sessB]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={() => {}}
        petView="pick" sessionsByWs={sessionsByWs} onPickerBack={() => {}} />
    )
    const sessions = container.querySelectorAll('.pk-sess')
    expect(sessions[0].classList.contains('on')).toBe(true)  // sessA selected
    expect(sessions[1].classList.contains('on')).toBe(false)
  })

  it('running .pk-sess shows .sd.run and pk-live 运行中', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={tgtPicker} sessionsForTarget={[sessA, sessB]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={() => {}}
        petView="pick" sessionsByWs={sessionsByWs} onPickerBack={() => {}} tgtWsRunning={true} />
    )
    const sessions = container.querySelectorAll('.pk-sess')
    // sessA is activeSessionId of alpha and tgtWsRunning=true
    expect(sessions[0].querySelector('.sd')!.classList.contains('run')).toBe(true)
    expect(sessions[0].querySelector('.pk-live')).not.toBeNull()
    // sessB not running
    expect(sessions[1].querySelector('.pk-live')).toBeNull()
  })

  it('pk-ws shows pk-c N 会话 badge when workspace has >1 session', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={tgtPicker} sessionsForTarget={[sessA, sessB]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={() => {}}
        petView="pick" sessionsByWs={sessionsByWs} onPickerBack={() => {}} />
    )
    const pkWs = container.querySelectorAll('.pk-ws')
    // alpha has 2 sessions → pk-c visible
    const alphaGroup = pkWs[0]
    expect(alphaGroup.querySelector('.pk-c')).not.toBeNull()
    expect(alphaGroup.querySelector('.pk-c')!.textContent).toContain('2')
    // beta has 1 session → no pk-c
    const betaGroup = pkWs[1]
    expect(betaGroup.querySelector('.pk-c')).toBeNull()
  })

  it('petView=main (default) still renders normal body with .pp-send', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={tgtPicker} sessionsForTarget={[sessA, sessB]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={() => {}}
        petView="main" sessionsByWs={sessionsByWs} onPickerBack={() => {}} />
    )
    expect(container.querySelector('.pp-send')).not.toBeNull()
    expect(container.querySelector('.pk-ws')).toBeNull()
  })

  // ── Fix: picker uses real WorkspaceMeta name/status for non-target workspaces ──

  const wsMeta: import('@shared/types').WorkspaceMeta[] = [
    { path: '/ws/alpha', name: 'Alpha Project', status: 'run', projectCount: 1, workflowId: 'w1', pinned: false, archived: false, archivedAt: null, createdAt: 0, description: '' },
    { path: '/ws/beta', name: 'Backend API', status: 'run', projectCount: 2, workflowId: 'w2', pinned: false, archived: false, archivedAt: null, createdAt: 0, description: '' },
  ]

  it('non-target workspace .pk-wn shows real WorkspaceMeta.name, not path segment', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={tgtPicker} sessionsForTarget={[sessA, sessB]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={() => {}}
        petView="pick" sessionsByWs={sessionsByWs} onPickerBack={() => {}}
        workspaces={wsMeta} />
    )
    // All .pk-wn text content
    const pkWnElements = container.querySelectorAll('.pk-wn')
    const names = Array.from(pkWnElements).map(el => el.textContent)
    expect(names).toContain('Backend API')
    // must NOT fall back to path segment 'beta'
    expect(names).not.toContain('beta')
  })

  it('non-target workspace .pd reflects real WorkspaceMeta.status, not hardcoded idle', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={tgtPicker} sessionsForTarget={[sessA, sessB]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={() => {}}
        petView="pick" sessionsByWs={sessionsByWs} onPickerBack={() => {}}
        workspaces={wsMeta} />
    )
    const pkWsGroups = container.querySelectorAll('.pk-ws')
    // find the beta group by its pk-wn text
    const betaGroup = Array.from(pkWsGroups).find(el => el.querySelector('.pk-wn')?.textContent === 'Backend API')
    expect(betaGroup).not.toBeUndefined()
    const dot = betaGroup!.querySelector('.pd')
    expect(dot).not.toBeNull()
    // status='run' → dotClass returns 'run'
    expect(dot!.classList.contains('run')).toBe(true)
    expect(dot!.classList.contains('idle')).toBe(false)
  })

  it('falls back to path segment when no workspaces meta provided', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        tgt={tgtPicker} sessionsForTarget={[sessA, sessB]} onPickSess={() => {}} onOpenPicker={() => {}} onJump={() => {}}
        petView="pick" sessionsByWs={sessionsByWs} onPickerBack={() => {}}
        workspaces={undefined} />
    )
    const pkWnElements = container.querySelectorAll('.pk-wn')
    const names = Array.from(pkWnElements).map(el => el.textContent)
    // Without meta, falls back to path segment
    expect(names).toContain('beta')
  })
})

// ── Task 9 tests: 队列撤回 + 终止 还原到宠物输入框 ───────────────────────────

describe('PetPopup – Task 9: 撤回/终止 还原到宠物输入框', () => {
  it('clicking .qx calls onCancelCmd AND the input value becomes that item text', () => {
    const onCancelCmd = vi.fn()
    const onCmdChange = vi.fn()
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        currentWs="/w"
        queue={[{ id: 'q1', text: '重构登录模块', source: '宠物' }]}
        onSendCmd={() => {}} onCancelCmd={onCancelCmd}
        cmd="" onCmdChange={onCmdChange} />
    )
    fireEvent.click(container.querySelector('.qx')!)
    expect(onCancelCmd).toHaveBeenCalledWith('q1')
    expect(onCmdChange).toHaveBeenCalledWith('重构登录模块')
  })

  it('when running is provided, a 终止 button is shown', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        currentWs="/w" queue={[]} onSendCmd={() => {}} onCancelCmd={() => {}}
        cmd="" onCmdChange={() => {}}
        running={{ id: 'r1', text: '执行中的指令' }} onStop={() => {}} />
    )
    expect(container.querySelector('.pp-running')).not.toBeNull()
    expect(container.querySelector('.pp-stop')).not.toBeNull()
    expect(container.querySelector('.pp-stop')!.textContent).toBe('终止')
  })

  it('clicking 终止 calls onStop AND input value becomes running.text', () => {
    const onStop = vi.fn()
    const onCmdChange = vi.fn()
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        currentWs="/w" queue={[]} onSendCmd={() => {}} onCancelCmd={() => {}}
        cmd="" onCmdChange={onCmdChange}
        running={{ id: 'r1', text: '执行中的指令' }} onStop={onStop} />
    )
    fireEvent.click(container.querySelector('.pp-stop')!)
    expect(onStop).toHaveBeenCalled()
    expect(onCmdChange).toHaveBeenCalledWith('执行中的指令')
  })

  it('when running is null, no 终止 button is shown', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        currentWs="/w" queue={[]} onSendCmd={() => {}} onCancelCmd={() => {}}
        cmd="" onCmdChange={() => {}}
        running={null} onStop={() => {}} />
    )
    expect(container.querySelector('.pp-stop')).toBeNull()
    expect(container.querySelector('.pp-running')).toBeNull()
  })

  it('cmd prop controls the input value (controlled input)', () => {
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        currentWs="/w" queue={[]} onSendCmd={() => {}} onCancelCmd={() => {}}
        cmd="预填内容" onCmdChange={() => {}} />
    )
    const input = container.querySelector('.pp-send input') as HTMLInputElement
    expect(input.value).toBe('预填内容')
  })

  it('controlled mode: clicking 发送 calls onCmdChange with empty string (clears input)', () => {
    const onCmdChange = vi.fn()
    const { container } = render(
      <PetPopup open corner="right" data={data} onResolve={() => {}} onGo={() => {}} onClose={() => {}}
        currentWs="/w" queue={[]} onSendCmd={() => {}} onCancelCmd={() => {}}
        cmd="要发送的内容" onCmdChange={onCmdChange} />
    )
    fireEvent.click(container.querySelector('.pp-send button')!)
    expect(onCmdChange).toHaveBeenCalledWith('')
  })
})
