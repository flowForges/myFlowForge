import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PetPane } from './PetPane'
import type { Pet } from '@shared/types'

const pet: Pet = { enabled: true, skin: 'sprite', customPets: [], corner: 'right', pos: { bottom: 24 }, followCursor: false, idleAnimation: true, scale: 1, notify: { confirm: true, input: true, done: false }, interactionMode: 'full', states: { idle: { anim: 'float', accent: 'none' }, working: { anim: 'spin-halo', accent: 'none' }, confirm: { anim: 'alert', accent: 'warn' }, input: { anim: 'tilt', accent: 'accent' }, done: { anim: 'pulse-ok', accent: 'ok' } } }

describe('PetPane', () => {
  it('reflects pet config and reports changes', () => {
    const onChange = vi.fn()
    render(<PetPane pet={pet} onChange={onChange} />)
    fireEvent.click(screen.getByText('机器人'))
    expect(onChange).toHaveBeenCalledWith({ skin: 'bot' })
    fireEvent.click(screen.getByText('左下角'))
    expect(onChange).toHaveBeenCalledWith({ corner: 'left' })
    const doneRow = screen.getByText('任务完成时提醒').closest('.set-row') as HTMLElement
    fireEvent.click(doneRow.querySelector('.toggle') as HTMLElement)
    expect(onChange).toHaveBeenCalledWith({ notify: { confirm: true, input: true, done: true } })
  })

  it('edits a per-state anim and reports the full states map', () => {
    const onChange = vi.fn()
    const pet = { enabled: true, skin: 'sprite', corner: 'right', pos: { bottom: 24 }, notify: { confirm: true, input: true, done: false }, states: { idle: { anim: 'float', accent: 'none' }, working: { anim: 'spin-halo', accent: 'none' }, confirm: { anim: 'alert', accent: 'warn' }, input: { anim: 'tilt', accent: 'accent' }, done: { anim: 'pulse-ok', accent: 'ok' } } } as any
    const { container } = render(<PetPane pet={pet} onChange={onChange} />)
    // the idle row's 'bounce' anim option
    const btn = container.querySelector('[data-anim-state="idle"][data-anim="bounce"]') as HTMLElement
    expect(btn).not.toBeNull()
    fireEvent.click(btn)
    expect(onChange).toHaveBeenCalledWith({ states: { ...pet.states, idle: { anim: 'bounce', accent: 'none' } } })
  })

  it('per-state anim/accent segs use the wrapping seg-wrap variant', () => {
    const { container } = render(<PetPane pet={pet} onChange={vi.fn()} />)
    const animSeg = (container.querySelector('[data-anim-state="idle"]') as HTMLElement).closest('.seg')
    const accentSeg = (container.querySelector('[data-accent-state="idle"]') as HTMLElement).closest('.seg')
    expect(animSeg!.classList.contains('seg-wrap')).toBe(true)
    expect(accentSeg!.classList.contains('seg-wrap')).toBe(true)
  })
})
