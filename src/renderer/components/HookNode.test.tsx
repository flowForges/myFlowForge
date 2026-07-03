import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { HookNode } from './HookNode'
import type { AgentRuntime } from '@shared/types'

const baseHook: AgentRuntime = {
  id: 'hook-1',
  name: 'code-review-hook',
  role: '插件 · HOOK',
  provider: 'forge',
  model: 'hook',
  state: 'ok',
  hook: true,
  hookSkills: ['code-review'],
  hookTools: ['read'],
  logs: [
    { ts: '10:00:01', text: 'code-review skill applied', level: 'ok', kind: 'output' },
    { ts: '10:00:02', text: 'context injected', level: 'ok', kind: 'output' },
  ],
}

const agent: AgentRuntime = {
  id: 'hook:x', name: '确认闸', role: '工作流完成后', provider: 'claude', model: 'm',
  state: 'ok', logs: [{ ts: '0', text: '产出一行', level: 'ok' }], hook: true, hookSkills: [], hookTools: [],
}

describe('HookNode 折叠', () => {
  it('open=false 时隐藏产出区,只留头部', () => {
    render(<HookNode agent={agent} open={false} onToggle={() => {}} />)
    expect(screen.getByText('确认闸')).toBeTruthy()
    expect(screen.queryByText(/产出/)).toBeNull()
  })

  it('open=true 时显示产出区', () => {
    render(<HookNode agent={agent} open={true} onToggle={() => {}} />)
    expect(screen.getAllByText(/产出/).length).toBeGreaterThan(0)
  })

  it('点击头部触发 onToggle', () => {
    const onToggle = vi.fn()
    render(<HookNode agent={agent} open={false} onToggle={onToggle} />)
    fireEvent.click(screen.getByText('确认闸'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})

describe('HookNode', () => {
  it('renders 「插件 · HOOK」kind badge and name', () => {
    render(<HookNode agent={baseHook} open={true} onToggle={() => {}} />)
    expect(screen.getByText('code-review-hook')).toBeInTheDocument()
    // The kind badge text appears in .hook-kind; role also echoes it in .hook-when
    const badges = screen.getAllByText('插件 · HOOK')
    expect(badges.length).toBeGreaterThanOrEqual(1)
    // The dedicated kind badge has class hook-kind
    expect(badges.some(el => el.classList.contains('hook-kind'))).toBe(true)
  })

  it('renders skill capability badge with display name', () => {
    render(<HookNode agent={baseHook} open={true} onToggle={() => {}} />)
    // hookSkills: ['code-review'] → display name 'code-review' from HOOK_SKILLS
    expect(screen.getByText('code-review')).toBeInTheDocument()
    // skill label
    expect(screen.getByText('技能')).toBeInTheDocument()
  })

  it('renders tool capability badge with display name', () => {
    render(<HookNode agent={baseHook} open={true} onToggle={() => {}} />)
    // hookTools: ['read'] → display name '读取文件' from HOOK_TOOLS
    expect(screen.getByText('读取文件')).toBeInTheDocument()
    // tool label
    expect(screen.getByText('工具')).toBeInTheDocument()
  })

  it('renders output log lines', () => {
    render(<HookNode agent={baseHook} open={true} onToggle={() => {}} />)
    expect(screen.getByText('code-review skill applied')).toBeInTheDocument()
    expect(screen.getByText('context injected')).toBeInTheDocument()
  })

  it('shows state badge for ok state', () => {
    render(<HookNode agent={baseHook} open={true} onToggle={() => {}} />)
    expect(screen.getByText('完成')).toBeInTheDocument()
  })

  it('shows wait note when state is wait (no output)', () => {
    const waitAgent: AgentRuntime = { ...baseHook, state: 'wait', logs: [] }
    render(<HookNode agent={waitAgent} open={true} onToggle={() => {}} />)
    expect(screen.getByText('等待前序阶段完成后注入并执行')).toBeInTheDocument()
  })

  it('does not show wait note when state is ok', () => {
    render(<HookNode agent={baseHook} open={true} onToggle={() => {}} />)
    expect(screen.queryByText('等待前序阶段完成后注入并执行')).not.toBeInTheDocument()
  })

  it('renders multiple hookSkills', () => {
    const multiAgent: AgentRuntime = {
      ...baseHook,
      hookSkills: ['code-review', 'writing-plans'],
      hookTools: [],
    }
    render(<HookNode agent={multiAgent} open={true} onToggle={() => {}} />)
    expect(screen.getByText('code-review')).toBeInTheDocument()
    expect(screen.getByText('writing-plans')).toBeInTheDocument()
  })

  it('renders with no caps when hookSkills and hookTools are empty', () => {
    const noCapsAgent: AgentRuntime = { ...baseHook, hookSkills: [], hookTools: [] }
    render(<HookNode agent={noCapsAgent} open={true} onToggle={() => {}} />)
    expect(screen.queryByText('技能')).not.toBeInTheDocument()
    expect(screen.queryByText('工具')).not.toBeInTheDocument()
  })

  it('shows the 注入下一阶段上下文 hint when the hook is done (not running, not wait)', () => {
    const { container } = render(<HookNode agent={baseHook} open={true} onToggle={() => {}} />)
    expect(container.querySelector('.hook-inject')).not.toBeNull()
    expect(screen.getByText('注入下一阶段上下文')).toBeInTheDocument()
  })

  it('does not show the inject hint while running', () => {
    const runAgent: AgentRuntime = { ...baseHook, state: 'run' }
    const { container } = render(<HookNode agent={runAgent} open={true} onToggle={() => {}} />)
    expect(container.querySelector('.hook-inject')).toBeNull()
  })

  it('does not show the inject hint while waiting', () => {
    const waitAgent: AgentRuntime = { ...baseHook, state: 'wait', logs: [] }
    const { container } = render(<HookNode agent={waitAgent} open={true} onToggle={() => {}} />)
    expect(container.querySelector('.hook-inject')).toBeNull()
  })
})
