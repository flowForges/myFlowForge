import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { PetPane } from './PetPane'
import type { Pet } from '@shared/types'
import { PET_CUSTOM_MAX } from '@shared/petCustom'

const BASE_PET: Pet = {
  enabled: true, skin: 'sprite', customPets: [], corner: 'right', pos: { bottom: 24 }, followCursor: false, idleAnimation: true, scale: 1,
  notify: { confirm: true, input: true, done: false }, interactionMode: 'full',
  states: {
    idle: { anim: 'float', accent: 'none' }, working: { anim: 'spin-halo', accent: 'none' },
    confirm: { anim: 'alert', accent: 'warn' }, input: { anim: 'tilt', accent: 'accent' },
    done: { anim: 'pulse-ok', accent: 'ok' }
  }
}

beforeEach(() => {
  // Reset forge mock before each test
  // Images are now persisted to disk by the main process; the pickers return stored RELATIVE PATHS.
  ;(window as any).forge = {
    ...(window as any).forge,
    pickPetPack: vi.fn().mockResolvedValue({ name: 'kitty', images: { idle: 'pk/idle.png' } }),
    pickPetImage: vi.fn().mockResolvedValue({ path: 'up/idle.png' })
  }
})

describe('PetPane custom skin', () => {
  it('shows the built-in SVG skins as chips in the unified 形象 gallery and reports skin on click', () => {
    const onChange = vi.fn()
    render(<PetPane pet={BASE_PET} onChange={onChange} />)
    // 精灵/机器人/幽灵 now live as chips in the same gallery as the pets (no separate 「自定义」card)
    expect(screen.getByText('精灵')).not.toBeNull()
    expect(screen.getByText('机器人')).not.toBeNull()
    expect(screen.getByText('幽灵')).not.toBeNull()
    fireEvent.click(screen.getByText('机器人'))
    expect(onChange).toHaveBeenCalledWith({ skin: 'bot' })
  })

  it('selecting a pet chip switches skin to custom and sets the active id', () => {
    const onChange = vi.fn()
    const pet: Pet = {
      ...BASE_PET, skin: 'sprite',
      customPets: [{ id: 'a', name: '豆豆', emoji: '🐱' }],
      activeCustomPetId: undefined,
    }
    render(<PetPane pet={pet} onChange={onChange} />)
    fireEvent.click(screen.getByText('豆豆'))
    expect(onChange).toHaveBeenCalledWith({ skin: 'custom', activeCustomPetId: 'a' })
  })

  it('renames a user custom pet inline (click ✎, edit, Enter)', () => {
    const onChange = vi.fn()
    const pet: Pet = {
      ...BASE_PET, skin: 'custom',
      customPets: [{ id: 'a', name: '豆豆', emoji: '🐱' }],
      activeCustomPetId: 'a',
    }
    render(<PetPane pet={pet} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('重命名 豆豆'))
    const input = screen.getByLabelText('重命名 豆豆') as HTMLInputElement // input reuses the aria-label
    fireEvent.change(input, { target: { value: '旺财' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith({ customPets: [{ id: 'a', name: '旺财', emoji: '🐱' }] })
  })

  it('clicking 添加宠物包 calls pickPetPack and appends a customPets entry (skin:custom + active id)', async () => {
    const onChange = vi.fn()
    const customPet: Pet = { ...BASE_PET, skin: 'custom' }
    render(<PetPane pet={customPet} onChange={onChange} />)

    const btn = screen.getByText('添加宠物包')
    await act(async () => {
      fireEvent.click(btn)
      await Promise.resolve()
    })

    expect((window as any).forge.pickPetPack).toHaveBeenCalled()
    const arg = onChange.mock.calls[0][0]
    expect(arg.skin).toBe('custom')
    expect(arg.customPets).toHaveLength(1)
    expect(arg.customPets[0].images).toMatchObject({ idle: 'pk/idle.png' })
    expect(arg.customPets[0].name).toBe('kitty')  // named after the picked folder
    expect(arg.activeCustomPetId).toBe(arg.customPets[0].id)
  })

  it('does not call onChange when pickPetPack returns empty object', async () => {
    ;(window as any).forge.pickPetPack = vi.fn().mockResolvedValue({ name: '', images: {} })
    const onChange = vi.fn()
    const customPet: Pet = { ...BASE_PET, skin: 'custom' }
    render(<PetPane pet={customPet} onChange={onChange} />)

    await act(async () => {
      fireEvent.click(screen.getByText('添加宠物包'))
      await Promise.resolve()
    })

    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not call onChange when pickPetPack rejects (swallows error silently)', async () => {
    ;(window as any).forge.pickPetPack = vi.fn().mockRejectedValue(new Error('dialog cancelled'))
    const onChange = vi.fn()
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const customPet: Pet = { ...BASE_PET, skin: 'custom' }
    render(<PetPane pet={customPet} onChange={onChange} />)

    await act(async () => {
      fireEvent.click(screen.getByText('添加宠物包'))
      await Promise.resolve()
    })

    expect(onChange).not.toHaveBeenCalled()
    expect(consoleSpy).toHaveBeenCalledWith('[PetPane] pickPetPack failed', expect.any(Error))
    consoleSpy.mockRestore()
  })

  it('renders a gallery chip per custom pet and selects one on click', () => {
    const customPet: Pet = {
      ...BASE_PET, skin: 'custom',
      customPets: [
        { id: 'a', name: '豆豆', emoji: '🐱', color: 'red' },
        { id: 'b', name: '旺财', emoji: '🐶', color: 'blue' },
      ],
      activeCustomPetId: 'a',
    }
    const onChange = vi.fn()
    render(<PetPane pet={customPet} onChange={onChange} />)
    expect(screen.getByText('豆豆')).not.toBeNull()
    expect(screen.getByText('旺财')).not.toBeNull()
    fireEvent.click(screen.getByText('旺财'))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ activeCustomPetId: 'b' }))
  })

  it('deleting a custom pet removes it (and repoints active when the active one is deleted)', () => {
    const customPet: Pet = {
      ...BASE_PET, skin: 'custom',
      customPets: [
        { id: 'a', name: '豆豆', emoji: '🐱' },
        { id: 'b', name: '旺财', emoji: '🐶' },
      ],
      activeCustomPetId: 'a',
    }
    const onChange = vi.fn()
    render(<PetPane pet={customPet} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('删除 豆豆'))
    const arg = onChange.mock.calls[0][0]
    expect(arg.customPets.map((p: any) => p.id)).toEqual(['b'])
    expect(arg.activeCustomPetId).toBe('b')
  })

  it('disables add buttons at the pet cap', () => {
    const many = Array.from({ length: PET_CUSTOM_MAX }, (_, i) => ({ id: `p${i}`, name: `p${i}`, emoji: '🐾' }))
    const customPet: Pet = { ...BASE_PET, skin: 'custom', customPets: many }
    render(<PetPane pet={customPet} onChange={vi.fn()} />)
    expect((screen.getByText('添加宠物包') as HTMLButtonElement).disabled).toBe(true)
  })

  it('clicking 上传图片 creates a single-image pet stored only under images.idle and activates it', async () => {
    const onChange = vi.fn()
    render(<PetPane pet={{ ...BASE_PET, skin: 'custom' }} onChange={onChange} />)

    await act(async () => {
      fireEvent.click(screen.getByText('上传图片'))
      await Promise.resolve()
    })

    expect((window as any).forge.pickPetImage).toHaveBeenCalled()
    const arg = onChange.mock.calls[0][0]
    expect(arg.skin).toBe('custom')
    expect(arg.customPets).toHaveLength(1)
    expect(arg.customPets[0].images).toEqual({ idle: 'up/idle.png' })
    expect(arg.customPets[0].name).toBe('宠物 1')
    expect(arg.activeCustomPetId).toBe(arg.customPets[0].id)
  })

  it('shows the error message and does not call onChange when pickPetImage returns an error', async () => {
    ;(window as any).forge.pickPetImage = vi.fn().mockResolvedValue({ error: '图片超过大小上限(2MB)' })
    const onChange = vi.fn()
    render(<PetPane pet={{ ...BASE_PET, skin: 'custom' }} onChange={onChange} />)

    await act(async () => {
      fireEvent.click(screen.getByText('上传图片'))
      await Promise.resolve()
    })

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText('图片超过大小上限(2MB)')).not.toBeNull()
  })

  it('does nothing when pickPetImage returns null (dialog cancelled)', async () => {
    ;(window as any).forge.pickPetImage = vi.fn().mockResolvedValue(null)
    const onChange = vi.fn()
    render(<PetPane pet={{ ...BASE_PET, skin: 'custom' }} onChange={onChange} />)

    await act(async () => {
      fireEvent.click(screen.getByText('上传图片'))
      await Promise.resolve()
    })

    expect(onChange).not.toHaveBeenCalled()
  })

  it('disables 上传图片 at the pet cap', () => {
    const many = Array.from({ length: PET_CUSTOM_MAX }, (_, i) => ({ id: `p${i}`, name: `p${i}`, emoji: '🐾' }))
    render(<PetPane pet={{ ...BASE_PET, skin: 'custom', customPets: many }} onChange={vi.fn()} />)
    expect((screen.getByText('上传图片') as HTMLButtonElement).disabled).toBe(true)
  })

  it('换图 on a state overwrites only that state image of the active pet', async () => {
    ;(window as any).forge.pickPetImage = vi.fn().mockResolvedValue({ path: 'a/working.png' })
    const onChange = vi.fn()
    const petWithImage: Pet = {
      ...BASE_PET, skin: 'custom',
      customPets: [
        { id: 'a', name: '豆豆', images: { idle: 'a/idle.png' } },
        { id: 'b', name: '旺财', emoji: '🐶' },
      ],
      activeCustomPetId: 'a',
    }
    render(<PetPane pet={petWithImage} onChange={onChange} />)

    await act(async () => {
      fireEvent.click(screen.getByLabelText('换图 执行中'))
      await Promise.resolve()
    })

    const arg = onChange.mock.calls[0][0]
    expect(arg.customPets.find((p: any) => p.id === 'a').images).toEqual({
      idle: 'a/idle.png',
      working: 'a/working.png',
    })
    // The other pet is untouched
    expect(arg.customPets.find((p: any) => p.id === 'b')).toEqual({ id: 'b', name: '旺财', emoji: '🐶' })
  })

  it('preview rows fall back to the idle image for states without their own image', () => {
    const petWithImage: Pet = {
      ...BASE_PET, skin: 'custom',
      customPets: [{ id: 'a', name: '豆豆', images: { idle: 'data:image/png;base64,IDLE' } }],
      activeCustomPetId: 'a',
    }
    const { container } = render(<PetPane pet={petWithImage} onChange={vi.fn()} />)
    // 5 preview states + 1 gallery thumbnail, all showing the idle image
    const imgs = Array.from(container.querySelectorAll('img[src="data:image/png;base64,IDLE"]'))
    expect(imgs.length).toBe(6)
  })
})
