import type { CustomPetCfg, PetState } from './types'

// 不再有「随安装包发货的图片宠物」。首次安装的默认形象是内置 SVG「幽灵」(pet.skin='ghost'),它是矢量、
// 零字节,断网也一定有东西显示。所有图片宠物 —— 包括从前随包的 white-catgirl —— 都改成从
// flowForges/pet-packs 按需下载(设置 → 宠物 → 宠物库),下载后存到用户本地。
//
// 为什么把最后一只也拿掉:white-catgirl 的 5 张 animated webp 是 4.3MB,而它只是「默认长这样」,
// 大多数用户装完就换掉了 —— 为一个默认值让每个安装包都背 4.3MB 不划算。
export const BUILTIN_PET_IDS: readonly string[] = []

// 老版本随包发过的宠物 id。它们的图片已经不在包里了,启动迁移据此识别「指向已下架内置宠物」的老配置,
// 回落到幽灵(见 src/main/index.ts)。用户可以在宠物库里把它重新下载回来。
export const LEGACY_BUNDLED_PET_IDS: readonly string[] = ['white-catgirl']

const PET_STATES: PetState[] = ['idle', 'working', 'confirm', 'input', 'done']

// 下载回来的包仍按这个相对路径存图,所以路径拼装保留。
export function builtinPetImagePath(id: string, state: PetState): string {
  return `builtin/${id}/webp/${state}.webp`
}

export function builtinPets(): CustomPetCfg[] { return [] }

export function mergeBuiltinPets(customPets: CustomPetCfg[] = []): CustomPetCfg[] {
  // 内置项已清空;这里只负责把老配置里残留的 builtin- 条目摘掉,用户自己装的原样保留。
  return customPets.filter(p => !p.id.startsWith('builtin-'))
}

export function hasAllBuiltinPets(customPets: CustomPetCfg[] = []): boolean {
  const ids = new Set(customPets.map(p => p.id))
  return BUILTIN_PET_IDS.every(id => ids.has(`builtin-${id}`))
}

/** 这条配置是否指向一只「已不再随包发货」的老内置宠物 —— 是的话要迁移回幽灵。 */
export function isLegacyBundledPet(id: string | undefined): boolean {
  return !!id && LEGACY_BUNDLED_PET_IDS.some(x => id === `builtin-${x}`)
}

export { PET_STATES as BUILTIN_PET_STATES }
