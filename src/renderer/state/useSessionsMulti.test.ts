import { it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useSessionsMulti } from './useSessionsMulti'

beforeEach(() => {
  ;(globalThis as any).window = (globalThis as any).window ?? {}
  ;(window as any).forge = {
    sessionList: vi.fn(async (p: string) => ({ sessions: [{ id: p + '-s1', title: 'a', mode: 'chat', createdAt: 0 }], activeSessionId: p + '-s1' })),
    onSessionsChanged: vi.fn(() => () => {}),
  }
})

it('loads sessions for each path', async () => {
  const { result } = renderHook(() => useSessionsMulti(['/w1', '/w2']))
  await waitFor(() => {
    expect(result.current['/w1']?.[0]?.id).toBe('/w1-s1')
    expect(result.current['/w2']?.[0]?.id).toBe('/w2-s1')
  })
})
