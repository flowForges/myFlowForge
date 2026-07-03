import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SessionTabs } from './SessionTabs'
import type { ChatSession } from '@shared/types'

const sessions: ChatSession[] = [
  { id: 's1', title: '主会话', mode: 'chat', createdAt: 0 },
]

beforeEach(() => {
  ;(window as any).forge = {
    agentSessionIds: vi.fn(async () => []),
  }
})

describe('SessionTabs IDs popover outside-click dismiss', () => {
  it('opens the IDs panel on button click', async () => {
    render(
      <SessionTabs
        sessions={sessions}
        activeSessionId="s1"
        onSwitch={() => {}}
        onClose={() => {}}
        onRename={() => {}}
        onNew={() => {}}
        workspacePath="/ws"
      />
    )
    const btn = document.querySelector('.sess-ids-btn')!
    expect(btn).toBeTruthy()
    expect(document.querySelector('.session-id-panel')).toBeNull()

    fireEvent.click(btn)
    await waitFor(() => expect(document.querySelector('.session-id-panel')).toBeTruthy())
  })

  it('closes the IDs panel when clicking outside', async () => {
    render(
      <SessionTabs
        sessions={sessions}
        activeSessionId="s1"
        onSwitch={() => {}}
        onClose={() => {}}
        onRename={() => {}}
        onNew={() => {}}
        workspacePath="/ws"
      />
    )
    // Open panel
    fireEvent.click(document.querySelector('.sess-ids-btn')!)
    await waitFor(() => expect(document.querySelector('.session-id-panel')).toBeTruthy())

    // Click outside → panel should close
    fireEvent.mouseDown(document.body)
    expect(document.querySelector('.session-id-panel')).toBeNull()
  })

  it('keeps the IDs panel open when clicking inside the panel', async () => {
    render(
      <SessionTabs
        sessions={sessions}
        activeSessionId="s1"
        onSwitch={() => {}}
        onClose={() => {}}
        onRename={() => {}}
        onNew={() => {}}
        workspacePath="/ws"
      />
    )
    // Open panel
    fireEvent.click(document.querySelector('.sess-ids-btn')!)
    await waitFor(() => expect(document.querySelector('.session-id-panel')).toBeTruthy())

    // Click inside the panel → should stay open
    const panel = document.querySelector('.session-id-panel')!
    fireEvent.mouseDown(panel)
    expect(document.querySelector('.session-id-panel')).toBeTruthy()
  })
})
