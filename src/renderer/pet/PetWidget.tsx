import { useEffect, useState, type ReactElement } from 'react'
import type { Pet, PetState, Anim, Accent } from '@shared/types'
import { petSrc } from './petSrc'
import { usePetImageTransition } from './usePetImageTransition'
import { PetAtlasSprite } from './PetAtlasSprite'
import type { PetAction } from '@shared/petAtlas'

const SPRITE_SVG: ReactElement = (
  <svg viewBox="0 0 64 64">
    <path d="M32 8c13 0 21 8.5 21 23 0 15-8.5 25-21 25S11 46 11 31C11 16.5 19 8 32 8Z" fill="var(--accent)" />
    <circle cx="24.5" cy="30" r="4" fill="#0b1020" />
    <circle cx="39.5" cy="30" r="4" fill="#0b1020" />
  </svg>
)

const SKIN_SVG: Record<Pet['skin'], ReactElement> = {
  sprite: SPRITE_SVG,
  bot: (
    <svg viewBox="0 0 64 64">
      <rect x="12" y="13" width="40" height="38" rx="12" fill="oklch(70% .03 250)" />
      <rect x="19" y="25" width="26" height="14" rx="7" fill="#0b1020" />
      <circle cx="26" cy="32" r="3.2" fill="var(--accent)" />
      <circle cx="38" cy="32" r="3.2" fill="var(--accent)" />
    </svg>
  ),
  ghost: (
    <svg viewBox="0 0 64 64">
      <path d="M32 9c12 0 19 8 19 21v22c0 2.4-2.7 3.6-4.5 2l-3-2.6c-1-.9-2.6-.9-3.6 0l-3.5 3c-1 .9-2.6.9-3.6 0l-3.6-3c-1-.9-2.6-.9-3.6 0l-3 2.6C19.7 55.6 17 54.4 17 52V30C17 17 20 9 32 9Z" fill="oklch(64% .15 300)" />
      <circle cx="25" cy="29" r="3.6" fill="#fff" />
      <circle cx="39" cy="29" r="3.6" fill="#fff" />
    </svg>
  ),
  // custom: resolved at render time via customImages prop; fallback = sprite
  custom: SPRITE_SVG
}

interface PetWidgetProps {
  skin: Pet['skin']
  anim: Anim
  accent: Accent
  state?: PetState
  customImages?: Partial<Record<PetState, string>>
  customEmoji?: { name: string; emoji: string; color: string }
  atlas?: { path: string; version: number }
  action?: PetAction
  lookDeg?: number | null
}

export function PetWidget({ skin, anim, accent, state, customImages, customEmoji, atlas, action, lookDeg }: PetWidgetProps) {
  const cls = `pet pet-anim-${anim} pet-accent-${accent}`
  const customSrc = customImages?.[state ?? 'idle'] ?? customImages?.idle
  const requestedSrc = petSrc(customSrc)
  const candidates = [...new Set(Object.values(customImages ?? {}).map(value => petSrc(value)).filter((value): value is string => Boolean(value)))]
  const imageLayers = usePetImageTransition(requestedSrc, candidates)
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null)
  useEffect(() => { setBrokenSrc(null) }, [requestedSrc])
  // Real orbiting stars for the sparkle anim (a box-shadow ::after just clones the 88px box → big rings)
  const stars = anim === 'sparkle'
    ? (
        <span className="pet-stars" aria-hidden="true">
          <i className="ps s1">✦</i>
          <i className="ps s2">✧</i>
          <i className="ps s3">✦</i>
        </span>
      )
    : null
  if (skin === 'custom') {
    // A Codex v2 atlas pet renders the sprite sheet (animation + look-at-cursor) instead of per-state
    // images; the shell (badge/handle/bubble) still wraps it via the outer .pet container.
    if (atlas) {
      return (
        <div className={cls} data-skin="custom-atlas">
          <PetAtlasSprite atlasPath={atlas.path} action={action ?? 'idle'} lookDeg={lookDeg} />
          {stars}
        </div>
      )
    }
    // A single-image pet stores only images.idle — every other state falls back to it.
    if (requestedSrc && brokenSrc !== requestedSrc && !imageLayers.failed.has(requestedSrc) && imageLayers.front) {
      return (
        <div className={cls} data-skin="custom">
          {/* draggable=false + onDragStart preventer: an <img> is natively drag-and-droppable, so
              press-dragging the pet would otherwise start an OS image drag (ghost image, drops a file
              on the desktop) instead of our own window drag. */}
          <span className="pet-image-stack">
            {imageLayers.fading && imageLayers.fading !== brokenSrc && (
              <img className="pet-image-fading" src={imageLayers.fading} alt="" draggable={false} onDragStart={e => e.preventDefault()} onError={() => setBrokenSrc(imageLayers.fading!)} />
            )}
            <img className="pet-image-front" src={imageLayers.front} alt="" draggable={false} onDragStart={e => e.preventDefault()} onError={() => setBrokenSrc(imageLayers.front!)} />
          </span>
          {stars}
        </div>
      )
    }
    // No per-state image — use the imported emoji (tinted with its color) if present.
    if (customEmoji?.emoji) {
      return (
        <div className={cls} data-skin="custom-emoji" style={customEmoji.color ? { color: customEmoji.color } : undefined}>
          <span className="pet-emoji" role="img" aria-label={customEmoji.name}>{customEmoji.emoji}</span>
          {stars}
        </div>
      )
    }
    // Nothing custom set — fall back to sprite SVG (pet never blank)
    return <div className={cls} data-skin="custom">{SPRITE_SVG}{stars}</div>
  }
  return <div className={cls} data-skin={skin}>{SKIN_SVG[skin]}{stars}</div>
}
