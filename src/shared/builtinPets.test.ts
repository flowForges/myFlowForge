import { describe, it, expect } from 'vitest'
import { BUILTIN_PET_IDS, LEGACY_BUNDLED_PET_IDS, builtinPets, mergeBuiltinPets, isLegacyBundledPet, builtinPetImagePath } from './builtinPets'

// 内置图片宠物已全部下架:默认形象是内置 SVG「幽灵」,图片宠物一律从 flowForges/pet-packs 按需下载。
// 这些用例钉住「不再有随包图片资源」这件事 —— 它直接关系到安装包体积(原先那一只是 4.3MB)。
describe('builtinPets', () => {
  it('★ 不再有随包发货的图片宠物', () => {
    expect(BUILTIN_PET_IDS).toEqual([])
    expect(builtinPets()).toEqual([])
  })

  it('mergeBuiltinPets 摘掉老配置里残留的 builtin- 条目,用户自己的原样保留', () => {
    const merged = mergeBuiltinPets([
      { id: 'builtin-white-catgirl', name: '成年白系猫娘' },
      { id: 'pet-1', name: '我自己的' },
    ])
    expect(merged.map(p => p.id)).toEqual(['pet-1'])
  })

  it('认得出老版本随包发过的宠物(用于启动迁移回落到幽灵)', () => {
    expect(LEGACY_BUNDLED_PET_IDS).toContain('white-catgirl')
    expect(isLegacyBundledPet('builtin-white-catgirl')).toBe(true)
    expect(isLegacyBundledPet('pet-1')).toBe(false)
    expect(isLegacyBundledPet(undefined)).toBe(false)
  })

  it('下载回来的包仍按同一套相对路径存图', () => {
    expect(builtinPetImagePath('white-catgirl', 'idle')).toBe('builtin/white-catgirl/webp/idle.webp')
  })
})
