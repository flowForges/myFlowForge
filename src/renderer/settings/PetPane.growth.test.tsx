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

const GROWTH_PET = {
  id: 'growth-tree-abc',
  name: '成长树',
  growth: {
    atlas: { cols: 4, cellW: 100, cellH: 100 },
    actions: { idle: { row: 0, durations: [200, 200] } },
    stages: [{ from: 0, sheet: 'growth-tree-abc/0-seed.png' }],
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

  // ★ IPC 本身 reject(主进程重启 / 通道没注册 / 主进程那侧漏了一个 throw)时,没有 catch 的
  // async onClick 会把 rejection 丢给 window.onunhandledrejection —— 界面上一点反应都没有,
  // 用户只知道「按钮点了没用」。这类无声失败必须变成看得见的红字。
  it('IPC 直接 reject 时也显示红字,不是无声失败', async () => {
    ;(window as any).forge.growthPetImport = vi.fn().mockRejectedValue(new Error('ENOSPC: no space left on device'))
    const onChange = vi.fn()
    const unhandled: unknown[] = []
    const onRej = (e: PromiseRejectionEvent) => { unhandled.push(e.reason); e.preventDefault() }
    window.addEventListener('unhandledrejection', onRej)
    try {
      render(<PetPane pet={BASE_PET} onChange={onChange} />)
      await act(async () => {
        fireEvent.click(screen.getByLabelText('安装成长宠物包'))
        await Promise.resolve()
      })
      expect(screen.getByText(/ENOSPC/)).not.toBeNull()
      expect(onChange).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('unhandledrejection', onRej)
    }
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

  // 画廊现在是一条连续的流,来源靠每个 chip 左上角的角标区分(不再用整行小标题把列表切断)。
  const tagsOf = (c: HTMLElement): string[] =>
    Array.from(c.querySelectorAll('.pet-custom-gallery .pet-chip-tag')).map(e => e.textContent ?? '')

  it('growth- 前缀的宠物挂「成长」角标,普通自定义挂「自定义」', () => {
    const pet: Pet = {
      ...BASE_PET, skin: 'custom',
      customPets: [{ id: 'pet-1', name: '豆豆', emoji: '🐱' }, { id: 'growth-tree-abc', name: '成长树' }],
    }
    const { container } = render(<PetPane pet={pet} onChange={vi.fn()} />)
    expect(screen.getByText('成长树')).not.toBeNull()
    const tags = tagsOf(container)
    expect(tags).toContain('成长')
    expect(tags).toContain('自定义')
  })

  it('★ 同来源的相邻排列:自定义在前,成长在后', () => {
    const pet: Pet = {
      ...BASE_PET, skin: 'custom',
      customPets: [
        { id: 'growth-a', name: '树A' }, { id: 'pet-1', name: '豆豆', emoji: '🐱' },
        { id: 'growth-b', name: '树B' }, { id: 'pet-2', name: '球球', emoji: '🐶' },
      ],
    }
    const { container } = render(<PetPane pet={pet} onChange={vi.fn()} />)
    const tags = tagsOf(container).filter(t => t === '自定义' || t === '成长')
    // 源数组里两类是交错的;渲染后必须先排完自定义再排成长
    expect(tags).toEqual(['自定义', '自定义', '成长', '成长'])
  })

  it('没有成长宠物时不出现「成长」角标', () => {
    const { container } = render(<PetPane pet={{ ...BASE_PET, customPets: [{ id: 'pet-1', name: '豆豆', emoji: '🐱' }] }} onChange={vi.fn()} />)
    expect(tagsOf(container)).not.toContain('成长')
  })
})

// Minor #2:到上限时安装按钮仍可点 —— 重装已装过的包是升级,不占新名额。
describe('PetPane 成长宠物包与宠物数量上限', () => {
  // 填满名额;caller 传进来的那几只放在最前面,便于制造「已装过 / 没装过」两种局面。
  const fill = (...head: { id: string; name: string }[]): Pet => ({
    ...BASE_PET, skin: 'custom',
    customPets: [
      ...head,
      ...Array.from({ length: PET_CUSTOM_MAX - head.length }, (_, i) => ({ id: `pet-fill-${i}`, name: `填充 ${i}` })),
    ],
  })
  const clickInstall = async () => {
    await act(async () => {
      fireEvent.click(screen.getByLabelText('安装成长宠物包'))
      await Promise.resolve()
    })
  }

  it('已达上限时按钮仍然可点(否则连升级都堵死了)', () => {
    render(<PetPane pet={fill()} onChange={vi.fn()} />)
    const btn = screen.getByLabelText('安装成长宠物包') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('已达上限时重装已装过的成长包 = 升级,照样生效', async () => {
    const onChange = vi.fn()
    const pet = fill({ id: 'growth-tree-abc', name: '旧名字' })
    expect(pet.customPets).toHaveLength(PET_CUSTOM_MAX) // 名额确实是满的
    render(<PetPane pet={pet} onChange={onChange} />)

    await clickInstall()

    expect(onChange).toHaveBeenCalled()
    const arg = onChange.mock.calls[0]![0]
    expect(arg.customPets).toHaveLength(PET_CUSTOM_MAX) // 没多出一只
    expect(arg.customPets.find((p: { id: string }) => p.id === 'growth-tree-abc').name).toBe('成长树')
    expect(arg.activeCustomPetId).toBe('growth-tree-abc')
    // 升级不是「新增」,不该冒出任何上限报错。
    expect(screen.queryByText(/已达上限/)).toBeNull()
  })

  it('已达上限时装一个没装过的新包会被拒,并给出说人话的提示', async () => {
    const onChange = vi.fn()
    render(<PetPane pet={fill()} onChange={onChange} />)

    await clickInstall()

    expect(onChange).not.toHaveBeenCalled()
    const msg = screen.getByText(/已达上限/)
    expect(msg.textContent).toContain('成长树')   // 到底是哪个包被拒了
    expect(msg.textContent).toContain('升级')     // 并说清「重装升级不受限」
  })
})

// Minor #1:画廊 chip 的缩略图。成长宠物没有 images/emoji,但有第一阶段的 atlas。
describe('PetPane 成长宠物缩略图', () => {
  const thumbOf = (id: string) => document.querySelector(`[data-growth-thumb="${id}"]`) as HTMLElement | null

  it('用第一阶段的 atlas 当缩略图,而不是落到 🐾 占位', () => {
    render(<PetPane pet={{ ...BASE_PET, skin: 'custom', customPets: [GROWTH_PET] }} onChange={vi.fn()} />)
    const el = thumbOf(GROWTH_PET.id)
    expect(el).not.toBeNull()
    expect(el!.style.backgroundImage).toContain('growth-tree-abc/0-seed.png')
    // chip 里不该再有那个占位表情。
    expect(screen.queryByText('🐾')).toBeNull()
  })

  it('只露出 idle 行第 0 帧,不是整张密密麻麻的格子', () => {
    render(<PetPane pet={{ ...BASE_PET, skin: 'custom', customPets: [GROWTH_PET] }} onChange={vi.fn()} />)
    const el = thumbOf(GROWTH_PET.id)!
    // cols=4、动作只有 idle(row 0) → 1 行:放大到 400% × 100%,再定位到左上第一格。
    expect(el.style.backgroundSize).toBe('400% 100%')
    expect(el.style.backgroundPosition).toBe('0% 0%')
    expect(el.style.backgroundRepeat).toBe('no-repeat')
  })

  it('多行 atlas 时按最大 row 推出行数,并定位到 idle 那一行', () => {
    const multi = {
      ...GROWTH_PET,
      id: 'growth-multi',
      growth: {
        ...GROWTH_PET.growth,
        // idle 故意不在第 0 行:缩略图必须跟着 idle.row 走,不能写死 0。
        actions: { idle: { row: 1, durations: [200] }, working: { row: 0, durations: [200] }, alert: { row: 3, durations: [200] } },
      },
    }
    render(<PetPane pet={{ ...BASE_PET, skin: 'custom', customPets: [multi] }} onChange={vi.fn()} />)
    const el = thumbOf('growth-multi')!
    expect(el.style.backgroundSize).toBe('400% 400%')          // max row 3 → 4 行
    expect(el.style.backgroundPosition).toBe(`0% ${(1 / 3) * 100}%`) // 4 行里的第 2 行 = 1/3
  })

  it('成长包坏了(stages 空)时安静回落到 🐾,不渲染半截背景', () => {
    const broken = { ...GROWTH_PET, id: 'growth-broken', growth: { ...GROWTH_PET.growth, stages: [] } }
    render(<PetPane pet={{ ...BASE_PET, skin: 'custom', customPets: [broken] }} onChange={vi.fn()} />)
    expect(thumbOf('growth-broken')).toBeNull()
    expect(screen.getByText('🐾')).not.toBeNull()
  })

  it('普通宠物(有 images)照旧走 <img>,不受影响', () => {
    const normal = { id: 'pet-1', name: '豆豆', images: { idle: 'pet-1/idle.png' } }
    render(<PetPane pet={{ ...BASE_PET, skin: 'custom', customPets: [normal] }} onChange={vi.fn()} />)
    expect(thumbOf('pet-1')).toBeNull()
    expect(document.querySelector('.pet-chip img')).not.toBeNull()
  })
})

