import type { PetState } from './types'
import type { GrowthPack } from './growthPet'

// Maximum gallery entries: 6 bundled pets + up to 10 user-added pets.
export const PET_CUSTOM_MAX = 16

// One custom pet: emoji-based (emoji+color), image-pack-based (per-state images), or both.
export interface CustomPet {
  id: string
  name: string
  emoji?: string
  color?: string
  images?: Partial<Record<PetState, string>>
  atlas?: { path: string; version: number }   // Codex v2 sprite atlas (forge-pet relpath)
  // 成长宠物包(kind:"growth")。stages[].sheet 已在装包时改写成 forge-pet 相对路径。
  // 与 atlas 互斥:有 growth 就走 GrowthSprite,不走 codex 的 PetAtlasSprite。
  growth?: GrowthPack
}

export interface ResolvedCustomPet {
  images: Partial<Record<PetState, string>>
  emoji?: { name: string; emoji: string; color: string }
  atlas?: { path: string; version: number }
  growth?: GrowthPack
}

// Pet config subset needed to resolve the active custom pet — the new customPets[] plus the legacy
// singular fields kept for back-compat.
interface CustomSource {
  customPets?: CustomPet[]
  activeCustomPetId?: string
  customImages?: Partial<Record<PetState, string>>
  customEmoji?: { name: string; emoji: string; color: string }
}

// Resolve which custom pet is active into the flat { images, emoji } shape PetWidget already consumes.
// Precedence: the selected entry of customPets (by activeCustomPetId, else the first) → the legacy singular
// customImages/customEmoji (only when customPets is empty). PetWidget then prefers a per-state image and
// falls back to the emoji.
export function resolveActiveCustomPet(pet: CustomSource): ResolvedCustomPet {
  const list = pet.customPets ?? []
  if (list.length) {
    const active = list.find(p => p.id === pet.activeCustomPetId) ?? list[0]
    return {
      images: active.images ?? {},
      emoji: active.emoji ? { name: active.name, emoji: active.emoji, color: active.color ?? '' } : undefined,
      atlas: active.atlas,
      growth: active.growth,
    }
  }
  return { images: pet.customImages ?? {}, emoji: pet.customEmoji }
}

// Append a custom pet, capped at PET_CUSTOM_MAX. Returns the list unchanged (never throws) when full so
// callers can guard the UI without try/catch; the zod .max(10) is the backstop at persist time.
export function addCustomPet(list: CustomPet[], pet: CustomPet): CustomPet[] {
  if (list.length >= PET_CUSTOM_MAX) return list
  return [...list, pet]
}

export function removeCustomPet(list: CustomPet[], id: string): CustomPet[] {
  return list.filter(p => p.id !== id)
}
