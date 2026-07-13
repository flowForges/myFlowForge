import type { CustomPetCfg, PetState } from './types'

// Only white-catgirl ships bundled now; the other packs (dragon / jellyfish / phoenix / rocket-fox /
// pink-catgirl) moved to on-demand download (Settings → Pet → pet gallery) to keep the installer small —
// their animated webp were ~32MB × 2 (Vite + extraResources). See src/main/petPack/petPackService.ts.
export const BUILTIN_PET_IDS = ['white-catgirl'] as const
export type BuiltinPetId = typeof BUILTIN_PET_IDS[number]

const PET_STATES: PetState[] = ['idle', 'working', 'confirm', 'input', 'done']

const NAME: Record<BuiltinPetId, string> = {
  'white-catgirl': '成年白系猫娘',
}

export const DEFAULT_BUILTIN_PET_ID: BuiltinPetId = 'white-catgirl'

// All built-ins are authored as real frame animation. Animated WebP preserves alpha and color while
// remaining small enough to bundle directly through Vite; GIF and APNG stay available as fallbacks.
export function builtinPetImagePath(id: BuiltinPetId, state: PetState): string {
  return `builtin/${id}/webp/${state}.webp`
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
