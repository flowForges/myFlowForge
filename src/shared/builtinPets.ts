import type { CustomPetCfg, PetState } from './types'

export const BUILTIN_PET_IDS = ['china-dragon', 'white-catgirl', 'rocket-fox', 'phoenix', 'cyber-jellyfish'] as const
export type BuiltinPetId = typeof BUILTIN_PET_IDS[number]

const PET_STATES: PetState[] = ['idle', 'working', 'confirm', 'input', 'done']

const NAME: Record<BuiltinPetId, string> = {
  'china-dragon': '中国龙',
  'white-catgirl': '成年白系猫娘',
  'rocket-fox': '火箭狐',
  phoenix: '凤凰',
  'cyber-jellyfish': '赛博水母',
}

export const DEFAULT_BUILTIN_PET_ID: BuiltinPetId = 'china-dragon'

// Use the per-state STATIC PNGs (png/<state>.png), not the <state>.gif animations: the gifs move the
// subject through a large 256px canvas ("大幅漂浮"/"8字飞"), so most frames — including the first, which
// is what a thumbnail and a paused <img> show — have the pet tiny or off-frame and read as blank. The
// PNGs are full, centered, per-state poses; the pet's own CSS animations (float/spin-halo/…) supply motion.
export function builtinPetImagePath(id: BuiltinPetId, state: PetState): string {
  return `builtin/${id}/png/${state}.png`
}

export function builtinPets(): CustomPetCfg[] {
  return BUILTIN_PET_IDS.map(id => ({
    id: `builtin-${id}`,
    name: NAME[id],
    images: Object.fromEntries(PET_STATES.map(state => [state, builtinPetImagePath(id, state)])) as Partial<Record<PetState, string>>,
  }))
}

export function mergeBuiltinPets(customPets: CustomPetCfg[] = []): CustomPetCfg[] {
  const builtins = builtinPets()
  const userPets = customPets.filter(p => !p.id.startsWith('builtin-'))
  return [...builtins, ...userPets]
}

export function hasAllBuiltinPets(customPets: CustomPetCfg[] = []): boolean {
  const ids = new Set(customPets.map(p => p.id))
  return BUILTIN_PET_IDS.every(id => ids.has(`builtin-${id}`))
}
