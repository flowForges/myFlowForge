import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useSettings } from './useSettings'


let saved: any = null
beforeEach(() => {
  saved = null
  ;(window as any).forge = {
    getSettings: vi.fn(async () => ({})),
    setSettings: vi.fn(async (s: any) => { saved = s; return s }),
    onSettingsChanged: () => () => {},
  }
})

describe('useSettings skills + pet', () => {
  it('defaults include skills + pet, and update merges them', async () => {
    const { result } = renderHook(() => useSettings())
    await waitFor(() => expect(result.current.settings).not.toBeNull())
    expect(result.current.settings!.skills['code-review']).toBe(true)
    expect(result.current.settings!.pet.skin).toBe('ghost')
    expect(result.current.settings!.pet.activeCustomPetId).toBeUndefined()
    expect(result.current.settings!.pet.skin).toBe('ghost')

    act(() => { result.current.update({ skills: { ...result.current.settings!.skills, 'deep-research': true } }) })
    expect(result.current.settings!.skills['deep-research']).toBe(true)
    expect(result.current.settings!.skills['code-review']).toBe(true)

    act(() => { result.current.update({ pet: { ...result.current.settings!.pet, skin: 'bot' } }) })
    expect(result.current.settings!.pet.skin).toBe('bot')
    expect(result.current.settings!.pet.enabled).toBe(true)
    await waitFor(() => expect(saved.pet.skin).toBe('bot'))
  })
})
