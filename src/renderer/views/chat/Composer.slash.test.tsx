import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Composer } from './Composer'
import type { ProviderInfo } from '@shared/types'

const providers = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus', label: 'Opus' }] },
  { id: 'codex', displayName: 'Codex', installed: true, models: [{ id: 'default', label: '账号默认' }] },
] as unknown as ProviderInfo[]

function renderComposer(agentId = 'claude') {
  const onSend = vi.fn()
  render(
    <Composer
      providers={providers}
      disabled={false}
      onSend={onSend}
      selection={{ agentId, modelId: agentId === 'claude' ? 'opus' : 'default' }}
      onSelectionChange={() => {}}
    />,
  )
  return { onSend, ta: screen.getByRole('textbox') as HTMLTextAreaElement }
}

describe('Composer slash commands', () => {
  it('typing "/" opens the menu including the universal 发起工作流', () => {
    const { ta } = renderComposer('claude')
    fireEvent.change(ta, { target: { value: '/' } })
    expect(screen.getByText('发起工作流')).toBeTruthy()
  })

  it('menu is provider-specific: claude sees 深度思考, not codex 先出计划', () => {
    const { ta } = renderComposer('claude')
    fireEvent.change(ta, { target: { value: '/' } })
    expect(screen.getByText('深度思考')).toBeTruthy()
    expect(screen.queryByText('先出计划')).toBeNull()
  })

  it('codex sees 先出计划, not claude 深度思考', () => {
    const { ta } = renderComposer('codex')
    fireEvent.change(ta, { target: { value: '/' } })
    expect(screen.getByText('先出计划')).toBeTruthy()
    expect(screen.queryByText('深度思考')).toBeNull()
  })

  it('filters the menu by the typed query', () => {
    const { ta } = renderComposer('claude')
    fireEvent.change(ta, { target: { value: '/架' } })
    expect(screen.getByText('梳理仓库架构')).toBeTruthy()
    expect(screen.queryByText('发起工作流')).toBeNull()
  })

  it('picking a command fills the textarea with its template and closes the menu', () => {
    const { ta } = renderComposer('claude')
    fireEvent.change(ta, { target: { value: '/架' } })
    fireEvent.mouseDown(screen.getByText('梳理仓库架构'))
    expect(ta.value).toContain('梳理这个仓库的架构')
    expect(screen.queryByText('梳理仓库架构')).toBeNull()   // menu closed after pick
  })

  it('dynamic on-disk commands appear alongside Forge commands (with a source tag)', () => {
    const onSend = vi.fn()
    render(
      <Composer
        providers={providers}
        disabled={false}
        onSend={onSend}
        selection={{ agentId: 'codex', modelId: 'default' }}
        onSelectionChange={() => {}}
        dynamicCommands={[{ cmd: '/analyst', title: 'analyst', desc: '需求分析', template: '/analyst ', kind: 'command' }]}
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/' } })
    expect(screen.getByText('analyst')).toBeTruthy()          // dynamic command
    expect(screen.getByText('发起工作流')).toBeTruthy()        // Forge command still present
    expect(screen.getByText('本机')).toBeTruthy()              // source tag
  })

  it('a space after the token closes the menu (writing the argument)', () => {
    const { ta } = renderComposer('claude')
    fireEvent.change(ta, { target: { value: '/工作流 做个登录页' } })
    expect(screen.queryByText('发起工作流')).toBeNull()
  })

  it('picking a workspace-workflow entry calls onPickWorkflow (not the empty template) and closes the menu', () => {
    const onSend = vi.fn()
    const onPickWorkflow = vi.fn()
    render(
      <Composer
        providers={providers}
        disabled={false}
        onSend={onSend}
        selection={{ agentId: 'claude', modelId: 'opus' }}
        onSelectionChange={() => {}}
        dynamicCommands={[{ cmd: '/快速修复', title: '快速修复', desc: '按此工作流发起', template: '', kind: 'forge', workflowId: 'wf-1' }]}
        onPickWorkflow={onPickWorkflow}
      />,
    )
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '/快速' } })
    fireEvent.mouseDown(screen.getByText('快速修复'))
    expect(onPickWorkflow).toHaveBeenCalledWith('wf-1')
    expect(ta.value).toBe('')
    expect(screen.queryByText('快速修复')).toBeNull()   // menu closed after pick
  })
})
