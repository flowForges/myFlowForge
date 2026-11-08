// 两次点击落在同一帧里(React 还没重渲染、按钮还没变灰)只发一次:守卫是 ref,不是 state(Task 6 评审)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DeleteSession } from './DeleteSession'
import { NewSession } from './NewSession'
import { SessionList } from './SessionList'
import { MffaiComposer } from './MffaiComposer'
import { DeleteSources } from '../ui/DeleteSources'
import { route } from '../route'
import { installFakeForge } from '../test/fakeForge'
import { perms, runRow, summary } from '../test/sessions'

const pending = () => new Promise<never>(() => {})
/** 一次 act 里点两下:中间没有重渲染 */
const twice = (el: HTMLElement, fire: (el: HTMLElement) => void = (e) => e.click()) => act(() => { fire(el); fire(el) })

beforeEach(() => { route.set({ page: 'chat' }) })

describe('double submit in one frame sends once', () => {
  it('DeleteSession', async () => {
    const f = installFakeForge({ calls: { 'executor.runs': { runs: [] }, 'session.delete': pending } })
    render(<DeleteSession session={summary('s1')} onClose={() => {}} onDeleted={() => {}} />)
    const ok = screen.getByRole('dialog').querySelector('.confirm-danger') as HTMLButtonElement
    await waitFor(() => expect(ok.disabled).toBe(false))
    twice(ok)
    expect(f.callsOf('session.delete')).toHaveLength(1)
  })

  it('DeleteSession: the retry key keeps run ids apart (JSON, not a comma join)', async () => {
    // 第一次列的是一个叫 `a,b` 的运行;后台回 unmerged,列出 a 和 b 两个:这是另一次操作,commandId 要换
    const f = installFakeForge({ calls: {
      'executor.runs': { runs: [runRow('a,b', 's1', { worktree: { path: '/w', present: true }, changed: 1 })] },
      'session.delete': () => { throw { code: -32602, message: 'unmerged', data: { reason: 'unmerged', runs: [{ runId: 'a', files: 1 }, { runId: 'b', files: 1 }] } } },
    } })
    render(<DeleteSession session={summary('s1')} onClose={() => {}} onDeleted={() => {}} />)
    const ok = () => screen.getByRole('dialog').querySelector('.confirm-danger') as HTMLButtonElement
    await waitFor(() => expect(ok().textContent).toBe('删除并丢弃改动'))
    await act(async () => { fireEvent.click(ok()) })
    await act(async () => { fireEvent.click(ok()) })
    const sent = f.callsOf('session.delete') as { commandId: string; discardUnmerged: string[] }[]
    expect(sent.map((s) => s.discardUnmerged)).toEqual([['a,b'], ['a', 'b']])
    expect(sent[1].commandId).not.toBe(sent[0].commandId)
  })

  it('NewSession', async () => {
    const f = installFakeForge({ calls: { 'permissions.get': perms('full'), 'session.create': pending } })
    f.mffai.models.catalog = vi.fn(async () => ({ presets: [], models: { p: [{ id: 'm1', name: 'M1', context: 1, output: 1, image: false, reasoning: 'none', toolCall: true }] }, default: { accountId: 'a1', modelId: 'm1' } }))
    f.mffai.models.accounts = vi.fn(async () => ({ accounts: [{ id: 'a1', presetId: 'p', label: 'acc', state: 'ok' }], secretsBackend: 'keychain' }))
    render(<NewSession onCreated={() => {}} />)
    const start = screen.getByRole('button', { name: '开始' }) as HTMLButtonElement
    await waitFor(() => expect(start.disabled).toBe(false))
    twice(start)
    expect(f.callsOf('session.create')).toHaveLength(1)
  })

  it('SessionList rename', async () => {
    installFakeForge()
    const onRename = vi.fn(pending)
    render(<SessionList sessions={[summary('s1', { title: 'old' })]} imNames={new Map()} onSelect={() => {}} onRename={onRename} onDelete={() => {}} />)
    fireEvent.doubleClick(screen.getByText('old'))
    const box = screen.getByRole('textbox', { name: '标题' })
    fireEvent.change(box, { target: { value: 'new' } })
    twice(box, (el) => fireEvent.keyDown(el, { key: 'Enter' }))
    expect(onRename).toHaveBeenCalledTimes(1)
  })

  it('MffaiComposer send', async () => {
    installFakeForge({ calls: { 'plugins.commands': { commands: [] } } })
    const onSend = vi.fn(pending)
    render(<MffaiComposer session={{ id: 's1', origin: 'app' }} canStop={false} onStop={() => {}} onCommand={async () => {}} onSend={onSend} />)
    const box = screen.getByRole('textbox', { name: '输入' })
    fireEvent.change(box, { target: { value: 'hi' } })
    twice(box, (el) => fireEvent.keyDown(el, { key: 'Enter' }))
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('DeleteSources', async () => {
    const f = installFakeForge({ calls: { 'memory.get': { id: 'n_a', layer: 'memory', text: 'x' }, 'memory.delete': pending } })
    render(<DeleteSources title={(n) => `记忆 ${n}`} ids={['n_a']} onClose={() => {}} />)
    twice(screen.getByRole('button', { name: '删除' }))
    expect(f.callsOf('memory.delete')).toHaveLength(1)
  })
})
