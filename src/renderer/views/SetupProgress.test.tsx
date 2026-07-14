import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SetupProgress, applySetupEvent, INITIAL_SETUP_STATE } from './SetupProgress'
import type { SetupProgressState } from './SetupProgress'
import type { SetupEvent } from '@shared/types'

describe('SetupProgress', () => {
  it('renders basic hooks, provisioned projects, proj hooks, and done indicator from accumulated state', () => {
    const state: SetupProgressState = {
      started: true,
      done: true,
      basicHooks: [
        {
          id: 'plugin-a',
          name: 'Plugin A',
          phase: '__basic',
          state: 'ok',
          logs: [{ ts: '10:00:00', text: 'basic hook ran', level: 'ok' }],
          skills: [],
          tools: [],
        },
      ],
      projHooks: [
        {
          id: 'plugin-b',
          name: 'Plugin B',
          phase: '__proj',
          state: 'wait',
          logs: [],
          skills: [],
          tools: [],
        },
      ],
      provisionedProjects: [{ name: 'proj-x', index: 0, total: 1 }],
      total: 1,
      pulling: null,
      failed: null,
      pendingInteraction: null,
    }

    render(<SetupProgress state={state} />)

    // Both hook names visible
    expect(screen.getByText('Plugin A')).toBeInTheDocument()
    expect(screen.getByText('Plugin B')).toBeInTheDocument()

    // Provisioned project name visible
    expect(screen.getByText(/proj-x/)).toBeInTheDocument()

    // Done indicator visible (unique text from the setup-done div)
    expect(screen.getByText(/全部完成/)).toBeInTheDocument()
  })

  it('renders in-progress state without done indicator', () => {
    const state: SetupProgressState = {
      started: true,
      done: false,
      basicHooks: [
        {
          id: 'plugin-a',
          name: 'Plugin A',
          phase: '__basic',
          state: 'run',
          logs: [{ ts: '10:00:00', text: 'running…', level: 'info' }],
          skills: [],
          tools: [],
        },
      ],
      projHooks: [],
      provisionedProjects: [],
      total: 0,
      pulling: null,
      failed: null,
      pendingInteraction: null,
    }

    render(<SetupProgress state={state} />)

    expect(screen.getByText('Plugin A')).toBeInTheDocument()
    expect(screen.queryByText(/全部完成/)).not.toBeInTheDocument()
  })

  it('while active shows 后台运行 + 取消; a running hook shows a live elapsed badge', () => {
    const onBackground = vi.fn(), onCancel = vi.fn()
    const state: SetupProgressState = {
      started: true, done: false,
      basicHooks: [{ id: 'h', name: 'Hook', phase: '__basic', state: 'run', logs: [], skills: [], tools: [], startedAt: Date.now() - 5000 }],
      projHooks: [], provisionedProjects: [], total: 0, pulling: null, failed: null, pendingInteraction: null,
    }
    render(<SetupProgress state={state} onBackground={onBackground} onCancel={onCancel} />)
    // elapsed badge for the running hook (started 5s ago)
    expect(screen.getByText(/运行中 ·/)).toBeInTheDocument()
    // background button hides without cancelling
    fireEvent.click(screen.getByLabelText('后台运行'))
    expect(onBackground).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })
})

const apply = (events: SetupEvent[]) => events.reduce(applySetupEvent, INITIAL_SETUP_STATE)

describe('applySetupEvent — provision progress', () => {
  it('provision:start marks the project as pulling with total', () => {
    const s = apply([
      { type: 'setup:start', workspacePath: '/ws', hooks: { basic: 0, proj: 0 } },
      { type: 'provision:start', project: 'alpha', index: 0, total: 2 },
    ])
    expect(s.pulling).toEqual({ project: 'alpha', index: 0 })
    expect(s.total).toBe(2)
    expect(s.provisionedProjects).toHaveLength(0)
  })

  it('provision moves the pulling project to completed and clears pulling', () => {
    const s = apply([
      { type: 'setup:start', workspacePath: '/ws', hooks: { basic: 0, proj: 0 } },
      { type: 'provision:start', project: 'alpha', index: 0, total: 2 },
      { type: 'provision', project: 'alpha', index: 0, total: 2 },
    ])
    expect(s.pulling).toBeNull()
    expect(s.provisionedProjects).toEqual([{ name: 'alpha', index: 0, total: 2 }])
  })

  it('provision:error records the failed project and clears pulling', () => {
    const s = apply([
      { type: 'setup:start', workspacePath: '/ws', hooks: { basic: 0, proj: 0 } },
      { type: 'provision:start', project: 'alpha', index: 0, total: 1 },
      { type: 'provision:error', project: 'alpha', index: 0, total: 1, message: 'clone failed' },
    ])
    expect(s.pulling).toBeNull()
    expect(s.failed).toEqual({ project: 'alpha', index: 0, message: 'clone failed' })
  })

  it('hook:interact sets a pending interaction; hook:state for that plugin clears it', () => {
    const s = apply([
      { type: 'setup:start', workspacePath: '/ws', hooks: { basic: 1, proj: 0 } },
      { type: 'hook:start', phase: '__basic', plugin: { id: 'p1', name: 'P1', skills: [], tools: [] } },
      { type: 'hook:interact', id: 'sh-1', pluginId: 'p1', kind: 'confirm', title: '允许运行安装脚本?' },
    ])
    expect(s.pendingInteraction).toEqual({ id: 'sh-1', pluginId: 'p1', kind: 'confirm', title: '允许运行安装脚本?', where: undefined, placeholder: undefined })
    const s2 = applySetupEvent(s, { type: 'hook:state', pluginId: 'p1', state: 'ok' })
    expect(s2.pendingInteraction).toBeNull()
  })

  it('renders the interaction card and reports the user decision', () => {
    const onResolveInteraction = vi.fn()
    const state: SetupProgressState = {
      started: true, done: false, basicHooks: [], projHooks: [], provisionedProjects: [],
      total: 0, pulling: null, failed: null,
      pendingInteraction: { id: 'sh-9', pluginId: 'p1', kind: 'confirm', title: '允许安装依赖?' },
    }
    render(<SetupProgress state={state} onResolveInteraction={onResolveInteraction} />)
    expect(screen.getByText('允许安装依赖?')).toBeInTheDocument()
    fireEvent.click(screen.getByText('允许'))
    expect(onResolveInteraction).toHaveBeenCalledWith('sh-9', { decision: 'allow' })
  })

  it('a two-project sequence ends with both completed and nothing pulling', () => {
    const s = apply([
      { type: 'setup:start', workspacePath: '/ws', hooks: { basic: 0, proj: 0 } },
      { type: 'provision:start', project: 'alpha', index: 0, total: 2 },
      { type: 'provision', project: 'alpha', index: 0, total: 2 },
      { type: 'provision:start', project: 'beta', index: 1, total: 2 },
      { type: 'provision', project: 'beta', index: 1, total: 2 },
      { type: 'setup:done', workspacePath: '/ws' },
    ])
    expect(s.pulling).toBeNull()
    expect(s.provisionedProjects).toHaveLength(2)
    expect(s.done).toBe(true)
  })
})
