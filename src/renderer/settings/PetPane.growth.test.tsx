import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { PetPane } from './PetPane'
import type { Pet } from '@shared/types'

const BASE_PET: Pet = {
  enabled: true, skin: 'sprite', customPets: [], corner: 'right', pos: { bottom: 24 }, followCursor: false, idleAnimation: true, scale: 1,
  notify: { confirm: true, input: true, done: false }, interactionMode: 'full',
  states: {
    idle: { anim: 'float', accent: 'none' }, working: { anim: 'spin-halo', accent: 'none' },
    confirm: { anim: 'alert', accent: 'warn' }, input: { anim: 'tilt', accent: 'accent' },
    done: { anim: 'pulse-ok', accent: 'ok' }
  }
}

const GROWTH_PET = {
  id: 'growth-tree-abc',
  name: '成长树',
  growth: {
    atlas: { cols: 4, cellW: 100, cellH: 100 },
    actions: { idle: { row: 0, durations: [200, 200] } },
    stages: [{ at: 0, sheet: 'growth-tree-abc/0-seed.png' }],
  },
}

beforeEach(() => {
  ;(window as any).forge = {
    ...(window as any).forge,
    growthPetImport: vi.fn().mockResolvedValue({ ok: true, pet: GROWTH_PET }),
    codexPetImport: vi.fn(),
    codexPetPick: vi.fn(),
    codexPetScan: vi.fn().mockResolvedValue([]),
  }
})

const goalInput = () => screen.getByLabelText('每日 token 目标') as HTMLInputElement

describe('PetPane 成长宠物包安装', () => {
  it('点「选择文件夹…」装包并把它 upsert 成当前形象', async () => {
    const onChange = vi.fn()
    render(<PetPane pet={BASE_PET} onChange={onChange} />)

    await act(async () => {
      fireEvent.click(screen.getByLabelText('安装成长宠物包'))
      await Promise.resolve()
    })

    expect((window as any).forge.growthPetImport).toHaveBeenCalled()
    const arg = onChange.mock.calls[0]![0]
    expect(arg.skin).toBe('custom')
    expect(arg.activeCustomPetId).toBe('growth-tree-abc')
    expect(arg.customPets).toHaveLength(1)
    expect(arg.customPets[0].growth.stages[0].sheet).toBe('growth-tree-abc/0-seed.png')
  })

  it('重装同一个包是升级不是再加一只(按 id upsert)', async () => {
    const onChange = vi.fn()
    const pet: Pet = { ...BASE_PET, skin: 'custom', customPets: [{ id: 'growth-tree-abc', name: '旧名字' }], activeCustomPetId: 'growth-tree-abc' }
    render(<PetPane pet={pet} onChange={onChange} />)

    await act(async () => {
      fireEvent.click(screen.getByLabelText('安装成长宠物包'))
      await Promise.resolve()
    })

    const arg = onChange.mock.calls[0]![0]
    expect(arg.customPets).toHaveLength(1)
    expect(arg.customPets[0].name).toBe('成长树')
  })

  it('装包失败时显示错误且不改设置', async () => {
    ;(window as any).forge.growthPetImport = vi.fn().mockResolvedValue({ ok: false, error: '目录下没有 pet.json' })
    const onChange = vi.fn()
    render(<PetPane pet={BASE_PET} onChange={onChange} />)

    await act(async () => {
      fireEvent.click(screen.getByLabelText('安装成长宠物包'))
      await Promise.resolve()
    })

    expect(screen.getByText('目录下没有 pet.json')).not.toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('用户取消(返回 null)既不报错也不改设置', async () => {
    ;(window as any).forge.growthPetImport = vi.fn().mockResolvedValue(null)
    const onChange = vi.fn()
    render(<PetPane pet={BASE_PET} onChange={onChange} />)

    await act(async () => {
      fireEvent.click(screen.getByLabelText('安装成长宠物包'))
      await Promise.resolve()
    })

    expect(onChange).not.toHaveBeenCalled()
    // 取消不是错误,不该有任何报错行冒出来(照 brief 返回 {ok:false,error:'已取消'} 就会渲成红字)
    expect(screen.queryByText('已取消')).toBeNull()
    expect(screen.queryByText('目录下没有 pet.json')).toBeNull()
  })

  it('growth- 前缀的宠物单独归到「成长宠物」组,不混进自定义那一堆', () => {
    const pet: Pet = {
      ...BASE_PET, skin: 'custom',
      customPets: [{ id: 'pet-1', name: '豆豆', emoji: '🐱' }, { id: 'growth-tree-abc', name: '成长树' }],
    }
    render(<PetPane pet={pet} onChange={vi.fn()} />)
    expect(screen.getByText('成长宠物')).not.toBeNull()
    expect(screen.getByText('成长树')).not.toBeNull()
    // 自定义那一组的计数不该把成长宠物算进去
    expect(screen.getByText(/添加自定义形象 · 1/)).not.toBeNull()
  })

  it('没有成长宠物时不显示「成长宠物」分组标题', () => {
    render(<PetPane pet={{ ...BASE_PET, customPets: [{ id: 'pet-1', name: '豆豆', emoji: '🐱' }] }} onChange={vi.fn()} />)
    expect(screen.queryByText('成长宠物')).toBeNull()
  })
})

describe('PetPane 每日 token 目标', () => {
  it('合法值失焦后存进 growthDailyGoal', () => {
    const onChange = vi.fn()
    render(<PetPane pet={BASE_PET} onChange={onChange} />)
    fireEvent.change(goalInput(), { target: { value: '200000' } })
    fireEvent.blur(goalInput())
    expect(onChange).toHaveBeenCalledWith({ growthDailyGoal: 200000 })
  })

  it('回车也提交', () => {
    const onChange = vi.fn()
    render(<PetPane pet={BASE_PET} onChange={onChange} />)
    fireEvent.change(goalInput(), { target: { value: '300000' } })
    fireEvent.keyDown(goalInput(), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith({ growthDailyGoal: 300000 })
  })

  it('编辑过程中一个字都不写盘(逐键提交会让宠物进度抖)', () => {
    const onChange = vi.fn()
    render(<PetPane pet={BASE_PET} onChange={onChange} />)
    for (const v of ['1', '10', '100', '1000', '10000', '100000']) {
      fireEvent.change(goalInput(), { target: { value: v } })
    }
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.blur(goalInput())
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ growthDailyGoal: 100000 })
  })

  it('清空 = 回到自动(存 undefined)', () => {
    const onChange = vi.fn()
    render(<PetPane pet={{ ...BASE_PET, growthDailyGoal: 200000 }} onChange={onChange} />)
    expect(goalInput().value).toBe('200000')
    fireEvent.change(goalInput(), { target: { value: '' } })
    fireEvent.blur(goalInput())
    expect(onChange).toHaveBeenCalledWith({ growthDailyGoal: undefined })
  })

  it.each([['3.5'], ['-1'], ['   '], ['0']])('非法值 %s 不会被存下', (bad) => {
    const onChange = vi.fn()
    render(<PetPane pet={BASE_PET} onChange={onChange} />)
    fireEvent.change(goalInput(), { target: { value: bad } })
    fireEvent.blur(goalInput())
    // 当前已是「自动」,坏值同样落到「自动」→ 没有任何变化要写
    expect(onChange).not.toHaveBeenCalled()
  })

  it('非法值把已存的目标退回自动,并把输入框归一化(不留骗人的残值)', () => {
    const onChange = vi.fn()
    render(<PetPane pet={{ ...BASE_PET, growthDailyGoal: 200000 }} onChange={onChange} />)
    fireEvent.change(goalInput(), { target: { value: '3.5' } })
    fireEvent.blur(goalInput())
    expect(onChange).toHaveBeenCalledWith({ growthDailyGoal: undefined })
    expect(goalInput().value).toBe('')
  })

  it('已保存的值原样回填输入框', () => {
    render(<PetPane pet={{ ...BASE_PET, growthDailyGoal: 1200000 }} onChange={vi.fn()} />)
    expect(goalInput().value).toBe('1200000')
  })
})
