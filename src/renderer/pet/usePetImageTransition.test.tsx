import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePetImageTransition } from './usePetImageTransition'

class DeferredImage {
  static instances: DeferredImage[] = []
  src = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  private resolveDecode!: () => void
  private rejectDecode!: () => void
  readonly decoded = new Promise<void>((resolve, reject) => {
    this.resolveDecode = resolve
    this.rejectDecode = reject
  })

  constructor() { DeferredImage.instances.push(this) }
  decode = () => this.decoded
  resolve() { this.resolveDecode() }
  reject() { this.rejectDecode() }
}

describe('usePetImageTransition', () => {
  beforeEach(() => {
    DeferredImage.instances = []
    vi.stubGlobal('Image', DeferredImage)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('preloads unique candidates and keeps the current front until the requested image decodes', async () => {
    const { result, rerender } = renderHook(
      ({ requested }) => usePetImageTransition(requested, ['idle.webp', 'work.webp', 'idle.webp']),
      { initialProps: { requested: 'idle.webp' } },
    )

    expect(DeferredImage.instances.map(image => image.src).sort()).toEqual(['idle.webp', 'work.webp'])
    expect(result.current.front).toBe('idle.webp')

    await act(async () => { DeferredImage.instances.find(image => image.src === 'idle.webp')!.resolve(); await Promise.resolve() })
    expect(result.current.front).toBe('idle.webp')

    rerender({ requested: 'work.webp' })
    expect(result.current.front).toBe('idle.webp')
    await act(async () => { DeferredImage.instances.find(image => image.src === 'work.webp')!.resolve(); await Promise.resolve() })

    expect(result.current.front).toBe('work.webp')
    expect(result.current.fading).toBe('idle.webp')
    act(() => { vi.advanceTimersByTime(120) })
    expect(result.current.fading).toBeUndefined()
  })

  it('records decode failures without replacing the visible image', async () => {
    const { result } = renderHook(() => usePetImageTransition('broken.webp', ['broken.webp']))
    await act(async () => {
      DeferredImage.instances[0].reject()
      DeferredImage.instances[0].onerror?.()
      await Promise.resolve()
    })
    expect(result.current.front).toBeUndefined()
    expect(result.current.failed.has('broken.webp')).toBe(true)
  })
})
