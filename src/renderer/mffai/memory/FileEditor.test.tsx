import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FileEditor } from './FileEditor'
import { fail, installFakeForge, type FakeForge } from '../test/fakeForge'
import { ev, resetSeq } from '../test/events'

let f: FakeForge

beforeEach(() => {
  resetSeq()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('FileEditor', () => {
  it('loads content, hash and cap; shows used/cap', async () => {
    f = installFakeForge({ calls: { 'memory.file.get': { content: 'hello', hash: 'h1', cap: 2000 } } })
    render(<FileEditor file="USER.md" />)
    expect(await screen.findByLabelText<HTMLTextAreaElement>('USER.md')).toHaveValue('hello')
    expect(screen.getByText('5 / 2000')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })

  it('saves with the loaded hash; masked chip shows, and the box reloads to the server-stored (masked, trimmed) text', async () => {
    f = installFakeForge({ calls: {
      'memory.file.get': { content: 'hello', hash: 'h1', cap: 2000 },
      'memory.file.set': { ok: true, hash: 'h2', masked: 1 },
    } })
    render(<FileEditor file="USER.md" />)
    const box = await screen.findByLabelText('USER.md')
    fireEvent.change(box, { target: { value: 'hello world' } })
    f.script({ 'memory.file.get': { content: 'hello [REDACTED]', hash: 'h2', cap: 2000 } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(f.callsOf('memory.file.set')).toEqual([{ commandId: expect.any(String), file: 'USER.md', content: 'hello world', expectedHash: 'h1' }])
    expect(screen.getByText('已打码 1')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('USER.md')).toHaveValue('hello [REDACTED]'))
    expect(f.callsOf('memory.file.get')).toHaveLength(2)
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })

  it('a memory.updated for this file that arrives while the save is still in flight is ignored (no false conflict)', async () => {
    let resolveSet!: (v: { ok: boolean; hash: string; masked: number }) => void
    f = installFakeForge({ calls: { 'memory.file.get': { content: 'hello', hash: 'h1', cap: 2000 } } })
    f.script({ 'memory.file.set': () => new Promise((r) => { resolveSet = r }) })
    render(<FileEditor file="USER.md" />)
    fireEvent.change(await screen.findByLabelText('USER.md'), { target: { value: 'edited' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    act(() => { f.emit(ev('memory.updated', { file: 'USER.md', op: 'write', source: 'user' })) })
    expect(screen.queryByRole('button', { name: '已在别处修改 · 重新载入' })).toBeNull()
    f.script({ 'memory.file.get': { content: 'server text', hash: 'h3', cap: 2000 } })
    await act(async () => { resolveSet({ ok: true, hash: 'h2', masked: 1 }) })
    expect(screen.queryByRole('button', { name: '已在别处修改 · 重新载入' })).toBeNull()
    expect(await screen.findByLabelText('USER.md')).toHaveValue('server text')
  })

  it('a hash conflict (ERR_BUSY) on save shows the reload button, not an overwrite', async () => {
    f = installFakeForge({ calls: {
      'memory.file.get': { content: 'hello', hash: 'h1', cap: 2000 },
      'memory.file.set': () => fail(-32003, 'file changed'),
    } })
    render(<FileEditor file="USER.md" />)
    fireEvent.change(await screen.findByLabelText('USER.md'), { target: { value: 'edited' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    const reload = await screen.findByRole('button', { name: '已在别处修改 · 重新载入' })
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    expect(screen.getByLabelText('USER.md')).toHaveValue('edited')
    f.script({ 'memory.file.get': { content: 'fresh', hash: 'h3', cap: 2000 } })
    await act(async () => { fireEvent.click(reload) })
    expect(screen.getByLabelText('USER.md')).toHaveValue('fresh')
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })

  it('an over-cap save (ERR_INVALID full) shows 已满 and keeps the dirty draft', async () => {
    f = installFakeForge({ calls: {
      'memory.file.get': { content: 'hello', hash: 'h1', cap: 2000 },
      'memory.file.set': () => fail(-32602, 'full'),
    } })
    render(<FileEditor file="MEMORY.md" />)
    fireEvent.change(await screen.findByLabelText('MEMORY.md'), { target: { value: 'too long' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(screen.getByText('已满')).toBeInTheDocument()
    expect(screen.getByLabelText('MEMORY.md')).toHaveValue('too long')
    expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled()
  })

  it('-32601 on load shows 不支持; a generic failure on save shows 失败 and a retry reuses the same commandId', async () => {
    f = installFakeForge({ calls: { 'memory.file.get': () => fail(-32601) } })
    render(<FileEditor file="USER.md" />)
    await screen.findByText('不支持')
  })

  it('a save failure keeps the draft dirty; retry reuses the same commandId', async () => {
    f = installFakeForge({ calls: {
      'memory.file.get': { content: 'hello', hash: 'h1', cap: 2000 },
      'memory.file.set': () => fail(-32010, 'timeout'),
    } })
    render(<FileEditor file="USER.md" />)
    fireEvent.change(await screen.findByLabelText('USER.md'), { target: { value: 'x' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(screen.getByText('失败')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    const sent = f.callsOf('memory.file.set') as { commandId: string }[]
    expect(sent[1].commandId).toBe(sent[0].commandId)
  })

  it('two clicks in one frame save once (ref guard against double submit)', async () => {
    f = installFakeForge({ calls: {
      'memory.file.get': { content: 'hello', hash: 'h1', cap: 2000 },
      'memory.file.set': () => new Promise<never>(() => {}),
    } })
    render(<FileEditor file="USER.md" />)
    fireEvent.change(await screen.findByLabelText('USER.md'), { target: { value: 'x' } })
    const save = screen.getByRole('button', { name: '保存' })
    act(() => { save.click(); save.click() })
    expect(f.callsOf('memory.file.set')).toHaveLength(1)
  })

  it('a remote memory.updated for this file refetches silently when clean', async () => {
    f = installFakeForge({ calls: { 'memory.file.get': { content: 'hello', hash: 'h1', cap: 2000 } } })
    render(<FileEditor file="USER.md" />)
    await screen.findByLabelText('USER.md')
    f.script({ 'memory.file.get': { content: 'changed elsewhere', hash: 'h2', cap: 2000 } })
    act(() => { f.emit(ev('memory.updated', { file: 'USER.md', op: 'write', source: 'user' })) })
    expect(await screen.findByLabelText('USER.md')).toHaveValue('changed elsewhere')
  })

  it('a remote memory.updated for this file while dirty shows the reload button instead of overwriting', async () => {
    f = installFakeForge({ calls: { 'memory.file.get': { content: 'hello', hash: 'h1', cap: 2000 } } })
    render(<FileEditor file="USER.md" />)
    fireEvent.change(await screen.findByLabelText('USER.md'), { target: { value: 'my edit' } })
    act(() => { f.emit(ev('memory.updated', { file: 'USER.md', op: 'write', source: 'user' })) })
    await screen.findByRole('button', { name: '已在别处修改 · 重新载入' })
    expect(screen.getByLabelText('USER.md')).toHaveValue('my edit')
  })

  it('a memory.updated for a different file is ignored', async () => {
    f = installFakeForge({ calls: { 'memory.file.get': { content: 'hello', hash: 'h1', cap: 2000 } } })
    render(<FileEditor file="USER.md" />)
    await screen.findByLabelText('USER.md')
    act(() => { f.emit(ev('memory.updated', { file: 'MEMORY.md', op: 'write', source: 'user' })) })
    expect(f.callsOf('memory.file.get')).toHaveLength(1)
  })

  it('a memory.updated with no file field (a delete/remove) refetches a clean editor silently', async () => {
    f = installFakeForge({ calls: { 'memory.file.get': { content: 'hello', hash: 'h1', cap: 2000 } } })
    render(<FileEditor file="USER.md" />)
    await screen.findByLabelText('USER.md')
    f.script({ 'memory.file.get': { content: 'changed broadly', hash: 'h2', cap: 2000 } })
    act(() => { f.emit(ev('memory.updated', { op: 'remove', source: 'user' })) })
    expect(await screen.findByLabelText('USER.md')).toHaveValue('changed broadly')
  })

  it('a memory.updated with no file field while dirty shows the reload button, not a silent overwrite', async () => {
    f = installFakeForge({ calls: { 'memory.file.get': { content: 'hello', hash: 'h1', cap: 2000 } } })
    render(<FileEditor file="USER.md" />)
    fireEvent.change(await screen.findByLabelText('USER.md'), { target: { value: 'my edit' } })
    act(() => { f.emit(ev('memory.updated', { op: 'remove', source: 'user' })) })
    await screen.findByRole('button', { name: '已在别处修改 · 重新载入' })
    expect(screen.getByLabelText('USER.md')).toHaveValue('my edit')
  })

  it('the 已用 counter strips a recognized provenance comment and trims, like the server cap check', async () => {
    const content = '- hello <!-- mff id=n_a src=user -->'
    f = installFakeForge({ calls: { 'memory.file.get': { content, hash: 'h1', cap: 2000 } } })
    render(<FileEditor file="USER.md" />)
    await screen.findByLabelText('USER.md')
    expect(screen.getByText(`${[...'- hello'].length} / 2000`)).toBeInTheDocument()
  })

  it('a comment that is not a recognized mff provenance tag counts toward the total (not stripped)', async () => {
    const content = '- hello <!-- not-mff -->'
    f = installFakeForge({ calls: { 'memory.file.get': { content, hash: 'h1', cap: 2000 } } })
    render(<FileEditor file="USER.md" />)
    await screen.findByLabelText('USER.md')
    expect(screen.getByText(`${[...content].length} / 2000`)).toBeInTheDocument()
  })

  it('readOnly disables the textarea and hides the save/reload actions, keeping whatever text is there', async () => {
    f = installFakeForge({ calls: { 'memory.file.get': { content: 'hello', hash: 'h1', cap: 2000 } } })
    render(<FileEditor file="USER.md" readOnly />)
    const box = await screen.findByLabelText<HTMLTextAreaElement>('USER.md')
    expect(box).toBeDisabled()
    expect(box).toHaveValue('hello')
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    expect(screen.queryByRole('button', { name: '已在别处修改 · 重新载入' })).toBeNull()
  })

  it('counts the whole document trimmed, across multiple lines with comments', async () => {
    const content = '- first <!-- mff id=n_a src=user -->\n- second <!-- mff id=n_b src=model -->\n'
    const expected = [...'- first\n- second'].length
    f = installFakeForge({ calls: { 'memory.file.get': { content, hash: 'h1', cap: 2000 } } })
    render(<FileEditor file="MEMORY.md" />)
    await screen.findByLabelText('MEMORY.md')
    expect(screen.getByText(`${expected} / 2000`)).toBeInTheDocument()
  })
})
