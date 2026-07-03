// Framework-free pet window geometry — safe to import from BOTH main (electron) and
// renderer (browser bundle). Keep this module free of electron/node imports so the
// drag hook can use snapCorner/posBottomFromBounds without pulling electron into the
// renderer bundle.

export interface WorkArea { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }

// Height is kept tight around the 88px sprite (16px top + 88 sprite + 16px bottom gap) so the collapsed
// window has minimal dead-space above the sprite — otherwise a tall window strands the sprite far below
// the top screen edge when docked there (macOS won't let the window overflow above the menu bar). The
// collapsed window only ever holds the bare sprite + badge: any popup/toast forces an expand to
// PET_EXPANDED first (see PetApp `expanded = open || toasts.length > 0`).
export const PET_COLLAPSED: Size = { width: 140, height: 120 }
export const PET_EXPANDED: Size = { width: 360, height: 560 }
export const PET_BUBBLE: Size = { width: 340, height: 220 }
export type PetSizeMode = 'collapsed' | 'bubble' | 'expanded'

// 0 = the pet window may hug the screen (work-area) edge when docked or dragged. The prototype keeps no
// collision gap; the only remaining inset from the screen edge is the sprite's own 16px padding inside
// its transparent window (room for the count badge), which is part of the prototype design.
export const MARGIN = 0

export function petBounds(workArea: WorkArea, corner: 'left' | 'right', size: Size, margin: number, posBottom?: number): { x: number; y: number; width: number; height: number } {
  const bottom = posBottom ?? margin
  const y = workArea.y + workArea.height - size.height - bottom
  // x snapping is margin-only (corner picks left/right edge); y uses posBottom ?? margin
  const x = corner === 'right'
    ? workArea.x + workArea.width - size.width - margin
    : workArea.x + margin
  return { x, y, width: size.width, height: size.height }
}

export function snapCorner(winLeft: number, winWidth: number, workArea: WorkArea): 'left' | 'right' {
  const center = winLeft + winWidth / 2
  return center < workArea.x + workArea.width / 2 ? 'left' : 'right'
}

export function posBottomFromBounds(winTop: number, winHeight: number, workArea: WorkArea): number {
  return Math.max(0, workArea.y + workArea.height - (winTop + winHeight))
}

// Clamp a top-left point so a window of `size` stays fully inside the work area, inset by `margin`
// on every edge — the pet keeps a gap from the desktop edges (collision) and never sits flush.
export function clampToWorkArea(x: number, y: number, size: Size, wa: WorkArea, margin = 0): { x: number; y: number } {
  return {
    x: Math.max(wa.x + margin, Math.min(x, wa.x + wa.width - size.width - margin)),
    y: Math.max(wa.y + margin, Math.min(y, wa.y + wa.height - size.height - margin)),
  }
}

// Vertical popup direction. 'up' = popup grows above the sprite (sprite hugs the window bottom — the
// prototype default); 'down' = popup grows below it (sprite hugs the window top). Mirrors `corner`,
// which is the HORIZONTAL axis.
export type PetVDir = 'up' | 'down'
export interface PetLayout { x: number; y: number; width: number; height: number; vdir: PetVDir }

// The clickable sprite box and its gap from the window's hugged edges. The collapsed window is
// PET_COLLAPSED.height tall with the sprite sitting GAP px from the BOTTOM, so its inset from the TOP
// is the remainder — that top inset is what keeps the sprite's on-screen position fixed across expand.
export const PET_SPRITE = 88   // base (scale=1) sprite box; renderer mirrors it via --pet-size
const SPRITE = PET_SPRITE
const GAP = 16
const COLLAPSED_TOP_INSET = PET_COLLAPSED.height - GAP - SPRITE // 16
// Horizontal dead space between the sprite and the window's docked edge (matches `.pet-hit { left/right: 16px }`).
const SPRITE_SIDE_INSET = 16

// ===== 宠物缩放(user-resizable sprite) =====
// The sprite can be resized by dragging the hover handle; scale is persisted in settings.pet.scale.
export const PET_SCALE_MIN = 0.6
export const PET_SCALE_MAX = 1.8
export function clampPetScale(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 1
  return Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, n))
}
export function petSpriteSize(scale = 1): number { return Math.round(SPRITE * scale) }
// Additive sizing: the window keeps its FIXED 16px insets (CSS .pet-hit left/right/bottom: 16px) around
// a scaled sprite, so all inset-based math (GAP / COLLAPSED_TOP_INSET / SPRITE_SIDE_INSET) stays
// scale-invariant — only the sprite box itself grows or shrinks.
export function petCollapsedSize(scale = 1): Size {
  const d = petSpriteSize(scale) - SPRITE
  return { width: PET_COLLAPSED.width + d, height: PET_COLLAPSED.height + d }
}
// Popup-mode windows (expanded/bubble) keep their base footprint — popup CONTENT doesn't scale — but
// must grow by the sprite's size increase so an enlarged sprite is never cropped. They never shrink
// below the base size (the popup needs the room regardless of a smaller sprite).
export function petPopupSize(base: Size, scale = 1): Size {
  const extra = Math.max(0, petSpriteSize(scale) - SPRITE)
  return { width: base.width, height: base.height + extra }
}

// ===== 缩放拖动预扩窗(live 阶段窗口零重排) =====
// While the resize handle is being dragged, re-bounding the window per pointermove fights the CSS
// re-render and makes the sprite jitter. Instead the main process grows the window ONCE (on
// petResizeBegin) to the LARGEST footprint the current mode can ever need (scale = PET_SCALE_MAX);
// the live drag is then pure CSS (--pet-size) with zero setBounds, and the release commits the final
// scale via petSetScale (whose dockPet shrinks the window back around the final size).
export function petMaxSize(mode: PetSizeMode): Size {
  return mode === 'collapsed'
    ? petCollapsedSize(PET_SCALE_MAX)
    : petPopupSize(mode === 'bubble' ? PET_BUBBLE : PET_EXPANDED, PET_SCALE_MAX)
}
// Grow the current layout for resize. Collapsed mode changes width and height, so grow it from the
// top-left; the renderer temporarily anchors the sprite from that same point and the visible
// bottom-right handle grows toward the pointer. Popup modes only need extra height for large sprites,
// so preserve their vertical popup direction to avoid jumping the open panel.
export function petResizeFootprint(l: PetLayout, corner: 'left' | 'right', size: Size): { x: number; y: number; width: number; height: number } {
  void corner
  if (size.width === l.width) {
    const y = l.vdir === 'up' ? l.y + l.height - size.height : l.y
    return { x: l.x, y, width: size.width, height: size.height }
  }
  return { x: l.x, y: l.y, width: size.width, height: size.height }
}

// Clamp so the SPRITE's 88px box — not the larger transparent window around it — stays inside the work
// area. The window is free to overflow the work-area edges; those regions are transparent and
// click-through, so overflowing them is harmless and lets the sprite sit flush against the usable screen
// edge. Without this we clamped the whole WINDOW, and the collapsed window's 56px of popup headroom above
// the sprite (up-mode) stranded it ~56px below the top edge. `size` is the window size; up-mode insets are
// assumed — collapsed is always up-mode, and resolvePetLayout always passes the collapsed size here.
// The region the pet sprite may occupy to reach the *physical* screen edges. The pet floats OVER the Dock
// (on whichever side it sits) to reach the bottom/left/right screen edges, but must stay BELOW the menu
// bar (it always occludes), so we take the full display `bounds` and trim only the top down to the work
// area's top (the menu-bar inset). General across Dock positions. Pass electron Display.bounds/.workArea.
export function petClampRegion(bounds: WorkArea, workArea: WorkArea): WorkArea {
  return { x: bounds.x, y: workArea.y, width: bounds.width, height: bounds.y + bounds.height - workArea.y }
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v }

// Map the pet's collapsed top-left from one display region to another, preserving its RELATIVE position
// within the region. Used by follow-cursor: when the cursor crosses to another display, the pet hops to
// the same relative spot on that display. Returns a sprite-clamped top-left for the target region.
export function relocatePetToRegion(free: { x: number; y: number }, from: WorkArea, to: WorkArea, scale = 1): { x: number; y: number } {
  const size = petCollapsedSize(scale)
  const spanX = from.width - size.width
  const spanY = from.height - size.height
  const fracX = spanX > 0 ? clamp01((free.x - from.x) / spanX) : 0
  const fracY = spanY > 0 ? clamp01((free.y - from.y) / spanY) : 0
  const x = to.x + fracX * Math.max(0, to.width - size.width)
  const y = to.y + fracY * Math.max(0, to.height - size.height)
  return clampPetSprite(x, y, size, to, scale)
}

export function clampPetSprite(x: number, y: number, size: Size, wa: WorkArea, scale = 1): { x: number; y: number } {
  const topInset = size.height - GAP - petSpriteSize(scale) // dead space above the sprite (window is taller than sprite)
  return {
    x: Math.max(wa.x - SPRITE_SIDE_INSET, Math.min(x, wa.x + wa.width - size.width + SPRITE_SIDE_INSET)),
    y: Math.max(wa.y - topInset, Math.min(y, wa.y + wa.height - size.height + GAP)),
  }
}

// Choose whether the expanded popup opens UP or DOWN so the larger window stays on its display WITHOUT
// moving the sprite. Prefer up (matches the prototype); use down when there isn't room above; if neither
// direction fully fits (tiny display), pick the side with more room.
export function pickVDir(collapsedTop: number, wa: WorkArea, margin: number, scale = 1): PetVDir {
  // COLLAPSED_TOP_INSET is scale-invariant (additive sizing keeps the fixed insets), and the vdir
  // decision always uses the LARGEST popup size (scaled PET_EXPANDED) so bubble→expanded mode
  // switches never flip the direction mid-run.
  const sprite = petSpriteSize(scale)
  const expH = petPopupSize(PET_EXPANDED, scale).height
  const spriteTop = collapsedTop + COLLAPSED_TOP_INSET
  const upTop = spriteTop - (expH - GAP - sprite) // window top if growing up
  if (upTop >= wa.y + margin) return 'up'
  const downBottom = (spriteTop - GAP) + expH // window bottom if growing down
  if (downBottom <= wa.y + wa.height - margin) return 'down'
  const roomAbove = spriteTop - (wa.y + margin)
  const roomBelow = (wa.y + wa.height - margin) - (spriteTop + sprite)
  return roomBelow > roomAbove ? 'down' : 'up'
}

// Resolve the pet window's bounds (and, when expanded from a free position, the popup direction). The
// sprite's on-screen position is held FIXED across collapse↔expand — only the popup grows, up or down,
// into whichever side has room. `free` is the collapsed window's ABSOLUTE top-left (global screen
// coords); the caller passes the workArea of the display that point lives on.
// Inverse of resolvePetLayout's placement: given the CURRENT pet window bounds (collapsed OR expanded)
// plus its corner + popup direction, return the collapsed free top-left that holds the sprite fixed.
// Used on drag-release — the pet may be dragged while the popup is open (expanded, sprite at the top in
// 'down' mode or bottom in 'up' mode), so the baseline must account for where the sprite actually sits.
export function freeFromWindow(
  winX: number, winY: number, winW: number, winH: number,
  corner: 'left' | 'right', vdir: PetVDir, scale = 1
): { x: number; y: number } {
  const collapsed = petCollapsedSize(scale)
  const x = corner === 'right' ? winX + winW - collapsed.width : winX
  const y = vdir === 'up' ? winY + winH - collapsed.height : winY - (COLLAPSED_TOP_INSET - GAP)
  return { x, y }
}

export function resolvePetLayout(
  workArea: WorkArea,
  opts: { corner: 'left' | 'right'; posBottom?: number; free?: { x: number; y: number } },
  expanded: boolean,
  margin: number,
  expandedSize: Size = PET_EXPANDED,
  scale = 1,
): PetLayout {
  const collapsed = petCollapsedSize(scale)
  const sprite = petSpriteSize(scale)
  const size = expanded ? expandedSize : collapsed
  if (!opts.free) {
    // Legacy corner dock: pinned to the bottom-{corner}; the popup always has room above it.
    return { ...petBounds(workArea, opts.corner, size, margin, opts.posBottom), vdir: 'up' }
  }
  // The clamped COLLAPSED rect is the sprite's fixed on-screen footprint. Clamp the SPRITE (not the
  // transparent window) so it can reach the work-area edges — including the top, where the window's popup
  // headroom would otherwise strand it.
  const coll = clampPetSprite(opts.free.x, opts.free.y, collapsed, workArea, scale)
  if (!expanded) return { x: coll.x, y: coll.y, width: collapsed.width, height: collapsed.height, vdir: 'up' }
  // Horizontal: keep the sprite's corner edge fixed, grow inward (right corner → leftward; left → right).
  const x = opts.corner === 'right' ? coll.x + collapsed.width - size.width : coll.x
  // Vertical: pick a direction with room, then place the window so the sprite's top stays put.
  const vdir = pickVDir(coll.y, workArea, margin, scale)
  const spriteTop = coll.y + COLLAPSED_TOP_INSET
  const y = vdir === 'up' ? spriteTop - (size.height - GAP - sprite) : spriteTop - GAP
  return { x, y, width: size.width, height: size.height, vdir }
}
