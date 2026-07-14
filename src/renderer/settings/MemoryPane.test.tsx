import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryPane } from './MemoryPane'

const read = vi.fn(); const write = vi.fn(); const clear = vi.fn()

beforeEach(() => {
  read.mockImplementation((a: { level: string }) => Promise.resolve(a.level === 'system' ? '## 偏好\n- 中文' : `${a.level} 内容`))
  write.mockResolvedValue(undefined)
  clear.mockResolvedValue(undefined)
  ;(globalThis as any).window.forge = { memoryRead: read, memoryWrite: write, memoryClear: clear }
})

describe('MemoryPane', () => {
  it('reflects the master switch and toggles it', () => {
    const onToggle = vi.fn()
    render(<MemoryPane enabled={true} onToggle={onToggle} />)
    const sw = screen.getByRole('checkbox', { name: /记忆功能/ })
    expect(sw).toBeChecked()
    fireEvent.click(sw)
    expect(onToggle).toHaveBeenCalledWith(false)
  })

  it('loads App memory always; shows hints for absent workspace/session scopes', async () => {
    render(<MemoryPane enabled={true} onToggle={() => {}} />)
    // App section is the only active editor → exactly one textbox, loaded with system content
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    await waitFor(() => expect(ta.value).toBe('## 偏好\n- 中文'))
    // No wsPath/sessionId → hints instead of editors
    expect(screen.getByText(/无活动工作区/)).toBeInTheDocument()
    expect(screen.getByText(/无活动会话/)).toBeInTheDocument()
  })

  it('loads workspace + session editors when scopes are active', async () => {
    render(<MemoryPane enabled={true} onToggle={() => {}} wsPath="/ws" sessionId="s1" />)
    expect(await screen.findByDisplayValue('workspace 内容')).toBeInTheDocument()
    expect(await screen.findByDisplayValue('session 内容')).toBeInTheDocument()
    expect(read).toHaveBeenCalledWith({ level: 'workspace', wsPath: '/ws', sessionId: undefined })
    expect(read).toHaveBeenCalledWith({ level: 'session', wsPath: '/ws', sessionId: 's1' })
  })

  it('save writes the edited content for that tier', async () => {
    render(<MemoryPane enabled={true} onToggle={() => {}} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    await waitFor(() => expect(ta.value).toBe('## 偏好\n- 中文'))
    fireEvent.change(ta, { target: { value: '## 偏好\n- 改了' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(write).toHaveBeenCalledWith({ level: 'system', wsPath: undefined, sessionId: undefined, content: '## 偏好\n- 改了' }))
  })

  it('clear empties the tier and calls memoryClear', async () => {
    render(<MemoryPane enabled={true} onToggle={() => {}} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    await waitFor(() => expect(ta.value).toBe('## 偏好\n- 中文'))
    fireEvent.click(screen.getByRole('button', { name: '清空' }))
    await waitFor(() => expect(clear).toHaveBeenCalledWith({ level: 'system', wsPath: undefined, sessionId: undefined }))
  })
})
