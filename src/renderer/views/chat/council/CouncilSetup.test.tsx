import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CouncilSetup, councilStartError } from './CouncilSetup'
import type { ProviderInfo } from '@shared/types'
import type { CouncilLastConfig } from '../../../state/useCouncil'

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] },
  { id: 'codex', displayName: 'Codex', installed: true, models: [{ id: 'gpt-6', label: 'GPT-6' }] },
  { id: 'cursor', displayName: 'Cursor', installed: true, models: [{ id: 'auto', label: 'Auto' }] },
  { id: 'gemini', displayName: 'Gemini', installed: false, models: [{ id: 'pro', label: 'Pro' }] },
]

function setup(over: Partial<React.ComponentProps<typeof CouncilSetup>> = {}) {
  const onStart = vi.fn()
  const utils = render(
    <CouncilSetup
      providers={providers}
      lastConfig={null}
      projects={async () => []}
      topic="议题"
      attachments={[]}
      blocked={false}
      onStart={onStart}
      {...over}
    />,
  )
  return { onStart, ...utils }
}

function addSeat(provider: string, model: string) {
  fireEvent.click(screen.getByRole('button', { name: '添加讨论方' }))
  fireEvent.click(document.querySelector(`.council-add [data-cprov="${provider}"]`)!)
  fireEvent.click(document.querySelector(`.council-add [data-cmodel="${model}"]`)!)
}

const seatIds = () => Array.from(document.querySelectorAll('.council-seat')).map(e => e.getAttribute('data-seat'))
const startBtn = () => screen.getByRole('button', { name: /开始讨论/ }) as HTMLButtonElement

describe('CouncilSetup', () => {
  it('provider picker lists only installed council-eligible CLIs (never cursor)', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: '添加讨论方' }))
    const ids = Array.from(document.querySelectorAll('.council-add [data-cprov]')).map(e => e.getAttribute('data-cprov'))
    expect(ids).toEqual(['claude', 'codex'])
  })

  it('start is disabled with 1 seat and enabled with 2 (leader defaults to the first seat)', () => {
    setup()
    addSeat('claude', 'opus')
    expect(startBtn().disabled).toBe(true)
    addSeat('codex', 'gpt-6')
    expect(startBtn().disabled).toBe(false)
  })

  it('a seated model is not offered again', () => {
    setup()
    addSeat('claude', 'opus')
    fireEvent.click(screen.getByRole('button', { name: '添加讨论方' }))
    fireEvent.click(document.querySelector('.council-add [data-cprov="claude"]')!)
    expect(document.querySelector('.council-add [data-cmodel="opus"]')).toBeNull()
    expect(document.querySelector('.council-add [data-cmodel="sonnet"]')).toBeTruthy()
  })

  it('start disabled when blocked or topic empty', () => {
    const { rerender, onStart } = setup()
    addSeat('claude', 'opus')
    addSeat('codex', 'gpt-6')
    const props = { providers, lastConfig: null, projects: async () => [], attachments: [], onStart }
    rerender(<CouncilSetup {...props} topic="议题" blocked={true} />)
    expect(startBtn().disabled).toBe(true)
    rerender(<CouncilSetup {...props} topic="  " blocked={false} />)
    expect(startBtn().disabled).toBe(true)
  })

  it('start passes seats in displayed order, labels, distinct leader id, mode', () => {
    const { onStart } = setup()
    addSeat('codex', 'gpt-6')
    addSeat('claude', 'opus')
    fireEvent.click(startBtn())
    const cfg = onStart.mock.calls[0][0]
    expect(cfg.topic).toBe('议题')
    expect(cfg.seats.map((s: { id: string }) => s.id)).toEqual(['codex:gpt-6', 'claude:opus'])
    expect(cfg.seats[0].label).toBe('Codex · GPT-6')
    expect(cfg.leader).toMatchObject({ provider: 'codex', model: 'gpt-6' })
    expect(cfg.leader.id).not.toBe(cfg.seats[0].id)
    expect(cfg.mode).toEqual({ kind: 'rounds', rounds: 2 })
    expect(cfg.materials).toBeUndefined()
  })

  it('drag-and-drop reorders seats', () => {
    const { onStart } = setup()
    addSeat('claude', 'opus')
    addSeat('codex', 'gpt-6')
    addSeat('claude', 'sonnet')
    const chips = document.querySelectorAll('.council-seat')
    fireEvent.dragStart(chips[2])
    fireEvent.dragOver(chips[0])
    fireEvent.drop(chips[0])
    expect(seatIds()).toEqual(['claude:sonnet', 'claude:opus', 'codex:gpt-6'])
    fireEvent.click(startBtn())
    expect(onStart.mock.calls[0][0].seats.map((s: { id: string }) => s.id)).toEqual(['claude:sonnet', 'claude:opus', 'codex:gpt-6'])
  })

  it('✕ removes a seat', () => {
    setup()
    addSeat('claude', 'opus')
    addSeat('codex', 'gpt-6')
    fireEvent.click(screen.getByRole('button', { name: '移除 Claude Code · Opus' }))
    expect(seatIds()).toEqual(['codex:gpt-6'])
  })

  it('leader picker sets a separate leader; consensus mode and rounds stepper', () => {
    const { onStart } = setup()
    addSeat('claude', 'opus')
    addSeat('codex', 'gpt-6')
    fireEvent.click(screen.getByRole('button', { name: /👑/ }))
    fireEvent.click(document.querySelector('.council-leader [data-cprov="claude"]')!)
    fireEvent.click(document.querySelector('.council-leader [data-cmodel="opus"]')!)
    fireEvent.click(screen.getByRole('button', { name: '+' }))
    fireEvent.click(startBtn())
    expect(onStart.mock.calls[0][0].leader).toMatchObject({ id: 'leader:claude:opus', provider: 'claude', model: 'opus', label: 'Claude Code · Opus' })
    expect(onStart.mock.calls[0][0].mode).toEqual({ kind: 'rounds', rounds: 3 })
    fireEvent.click(screen.getByRole('button', { name: '讨论到共识' }))
    fireEvent.click(startBtn())
    expect(onStart.mock.calls[1][0].mode).toEqual({ kind: 'consensus', maxRounds: 5, maxMinutes: 30 })
  })

  it('defaults come from lastConfig, dropping seats whose CLI is not available', () => {
    const last: CouncilLastConfig = {
      seats: [
        { id: 'codex:gpt-6', provider: 'codex', model: 'gpt-6', label: 'Codex · GPT-6' },
        { id: 'gemini:pro', provider: 'gemini', model: 'pro', label: 'Gemini · Pro' },
        { id: 'claude:opus', provider: 'claude', model: 'opus', label: 'Claude Code · Opus' },
      ],
      leader: { id: 'leader:claude:opus', provider: 'claude', model: 'opus', label: 'Claude Code · Opus' },
      mode: { kind: 'rounds', rounds: 4 },
    }
    const { onStart } = setup({ lastConfig: last })
    expect(seatIds()).toEqual(['codex:gpt-6', 'claude:opus'])
    fireEvent.click(startBtn())
    expect(onStart.mock.calls[0][0].mode).toEqual({ kind: 'rounds', rounds: 4 })
    expect(onStart.mock.calls[0][0].leader.id).toBe('leader:claude:opus')
  })

  it('materials: single project auto-selected; range must be non-empty', async () => {
    const { onStart } = setup({ projects: async () => [{ name: 'app', cwd: '/ws/app' }] })
    addSeat('claude', 'opus')
    addSeat('codex', 'gpt-6')
    await waitFor(() => expect((document.querySelector('.council-project') as HTMLSelectElement).value).toBe('/ws/app'))
    fireEvent.click(screen.getByRole('button', { name: '提交区间' }))
    expect(startBtn().disabled).toBe(true)
    fireEvent.change(document.querySelector('.council-range')!, { target: { value: 'a..b' } })
    expect(startBtn().disabled).toBe(false)
    fireEvent.click(startBtn())
    expect(onStart.mock.calls[0][0].materials).toEqual({ projectCwd: '/ws/app', diff: { range: 'a..b' } })
    fireEvent.click(screen.getByRole('button', { name: '文件' }))
    fireEvent.change(document.querySelector('.council-files')!, { target: { value: 'src/a.ts, src/b.ts ,' } })
    fireEvent.click(startBtn())
    expect(onStart.mock.calls[1][0].materials).toEqual({ projectCwd: '/ws/app', files: ['src/a.ts', 'src/b.ts'] })
    fireEvent.click(screen.getByRole('button', { name: '未提交的改动' }))
    fireEvent.click(startBtn())
    expect(onStart.mock.calls[2][0].materials).toEqual({ projectCwd: '/ws/app', diff: 'uncommitted' })
  })

  it('drops remembered seats whose model is gone; unusable leader falls back to the first seat', () => {
    const last: CouncilLastConfig = {
      seats: [
        { id: 'claude:old', provider: 'claude', model: 'old', label: 'Claude Code · Old' },
        { id: 'codex:gpt-6', provider: 'codex', model: 'gpt-6', label: 'Codex · GPT-6' },
        { id: 'claude:opus', provider: 'claude', model: 'opus', label: 'Claude Code · Opus' },
      ],
      leader: { id: 'leader:gemini:pro', provider: 'gemini', model: 'pro', label: 'Gemini · Pro' },
      mode: { kind: 'rounds', rounds: 2 },
    }
    const { onStart } = setup({ lastConfig: last })
    expect(seatIds()).toEqual(['codex:gpt-6', 'claude:opus'])
    fireEvent.click(startBtn())
    expect(onStart.mock.calls[0][0].leader).toMatchObject({ id: 'leader:codex:gpt-6', provider: 'codex', model: 'gpt-6' })
  })

  it('councilStartError maps IPC error codes', () => {
    expect(councilStartError(new Error("Error invoking remote method 'council:start': Error: busy"))).toBe('当前会话正忙')
    expect(councilStartError(new Error("Error invoking remote method 'council:start': Error: provider-not-installed"))).toBe('配置无效')
    expect(councilStartError(new Error('seats-too-few'))).toBe('配置无效')
    expect(councilStartError(new Error("Error invoking remote method 'council:start': Error: 工作区已归档，恢复后才能继续。"))).toBe('工作区已归档，恢复后才能继续。')
  })

  it('shows the estimate as an upper-bound minute count', () => {
    setup()
    addSeat('claude', 'opus')
    addSeat('codex', 'gpt-6')
    // 2 seats, 2 rounds: turns = 1 + 1*2 + 2 + 1 = 6 → hi = 12
    expect(screen.getByText('约 12 分钟')).toBeTruthy()
  })

  it('contains no hint text elements', () => {
    const { container } = setup({ projects: async () => [{ name: 'app', cwd: '/ws/app' }] })
    addSeat('claude', 'opus')
    expect(container.querySelector('.hint, [class*="hint"], small')).toBeNull()
  })
})
