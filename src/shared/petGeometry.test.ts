import { describe, it, expect } from 'vitest'
import { clampToWorkArea, resolvePetLayout, freeFromWindow, petClampRegion, relocatePetToRegion, PET_COLLAPSED, PET_BUBBLE, PET_EXPANDED, clampPetScale, petSpriteSize, petCollapsedSize, petPopupSize, clampPetSprite, PET_SCALE_MIN, PET_SCALE_MAX, petMaxSize, petResizeFootprint } from './petGeometry'

const WA = { x: 0, y: 0, width: 1000, height: 800 }

describe('relocatePetToRegion (follow-cursor)', () => {
  const A = { x: 0, y: 0, width: 1000, height: 800 }      // display A region
  const B = { x: 1000, y: 0, width: 1000, height: 800 }   // display B region, to the right

  it('maps the same relative position onto the target display', () => {
    // pet near top-right of A → should land near top-right of B
    const free = { x: A.x + A.width - PET_COLLAPSED.width, y: A.y }
    const out = relocatePetToRegion(free, A, B)
    // x should be near B's right edge (within the sprite side-inset slack), not back on A
    expect(out.x).toBeGreaterThan(B.x + B.width - PET_COLLAPSED.width - 40)
    expect(out.x).toBeLessThanOrEqual(B.x + B.width)
  })

  it('preserves the left/top corner across displays', () => {
    const out = relocatePetToRegion({ x: A.x, y: A.y }, A, B)
    expect(Math.round(out.x)).toBeGreaterThanOrEqual(B.x - 16)
    expect(Math.round(out.x)).toBeLessThan(B.x + 100)
  })

  it('maps onto a smaller target display without overflowing it', () => {
    const small = { x: 1000, y: 0, width: 600, height: 500 }
    const out = relocatePetToRegion({ x: A.x + A.width - PET_COLLAPSED.width, y: A.y + A.height - PET_COLLAPSED.height }, A, small)
    expect(out.x).toBeLessThanOrEqual(small.x + small.width)
    expect(out.y).toBeLessThanOrEqual(small.y + small.height)
  })
})

describe('clampToWorkArea', () => {
  it('keeps a point inside the work area accounting for size', () => {
    expect(clampToWorkArea(500, 400, { width: 140, height: 160 }, WA)).toEqual({ x: 500, y: 400 })
    expect(clampToWorkArea(-50, -50, { width: 140, height: 160 }, WA)).toEqual({ x: 0, y: 0 })
    expect(clampToWorkArea(9999, 9999, { width: 140, height: 160 }, WA)).toEqual({ x: 860, y: 640 })
  })
})

describe('petClampRegion', () => {
  it('keeps the full display width/bottom (float over the Dock) but trims the menu bar off the top', () => {
    // bounds = physical screen; workArea excludes menu bar (top 25) and a right-side Dock (80px).
    const bounds = { x: 0, y: 0, width: 1000, height: 800 }
    const workArea = { x: 0, y: 25, width: 920, height: 775 } // Dock on the right + menu bar on top
    expect(petClampRegion(bounds, workArea)).toEqual({ x: 0, y: 25, width: 1000, height: 775 })
  })
})

describe('resolvePetLayout', () => {
  it('collapsed free position (clamped) reports vdir up', () => {
    expect(resolvePetLayout(WA, { corner: 'right', free: { x: 300, y: 200 } }, false, 24))
      .toEqual({ x: 300, y: 200, width: 140, height: 120, vdir: 'up' })
  })
  it('clamps a collapsed free position that overflows the work area (sprite reaches the edge)', () => {
    // The SPRITE (not the window) is clamped, so the window may overflow by the sprite's dead-space:
    // x: 1000-140+16 = 876 (sprite right flush to edge); y: 800-120+16 = 696 (sprite bottom flush).
    expect(resolvePetLayout(WA, { corner: 'right', free: { x: 9999, y: 9999 } }, false, 24))
      .toEqual({ x: 876, y: 696, width: 140, height: 120, vdir: 'up' })
  })
  it('lets the sprite reach the TOP edge — window overflows upward by its 16px popup headroom', () => {
    // Regression: dragging to the top stranded the sprite below the edge. The window top is now allowed up
    // to wa.y - 16 (the collapsed top dead-space) so the sprite's top (window.y + 16) sits flush at wa.y.
    expect(resolvePetLayout(WA, { corner: 'right', free: { x: 300, y: -1000 } }, false, 24))
      .toEqual({ x: 300, y: -16, width: 140, height: 120, vdir: 'up' })
  })
  it('expands UP (popup above the sprite) when there is room above, keeping the sprite bottom fixed', () => {
    // collapsed at free{500,500}: window bottom = 500+120 = 620. Expanded (360x560) keeps that bottom fixed
    // so the pet sprite does not move — only the popup grows upward.
    expect(resolvePetLayout(WA, { corner: 'right', free: { x: 500, y: 500 } }, true, 24))
      .toEqual({ x: 280, y: 60, width: 360, height: 560, vdir: 'up' })   // 280+360=640, 60+560=620
  })
  it('anchors on the bottom-left edge when corner is left', () => {
    expect(resolvePetLayout(WA, { corner: 'left', free: { x: 200, y: 500 } }, true, 24))
      .toEqual({ x: 200, y: 60, width: 360, height: 560, vdir: 'up' })
  })
  it('falls back to corner dock (vdir up) when no free position', () => {
    expect(resolvePetLayout(WA, { corner: 'right', posBottom: 24 }, false, 24))
      .toEqual({ x: 1000 - 140 - 24, y: 800 - 120 - 24, width: 140, height: 120, vdir: 'up' })
  })

  // THE BUG: pet near the TOP edge. The popup must open DOWNWARD and the sprite must NOT move.
  it('expands DOWN when there is no room above, holding the sprite screen position fixed', () => {
    const coll = resolvePetLayout(WA, { corner: 'right', free: { x: 500, y: 30 } }, false, 24)
    const exp = resolvePetLayout(WA, { corner: 'right', free: { x: 500, y: 30 } }, true, 24)
    expect(exp).toEqual({ x: 280, y: 30, width: 360, height: 560, vdir: 'down' })
    // sprite top within the collapsed window = 30 + (120-16-88) = 46; expanded-down sprite top inset = 16
    // → window top = 46 - 16 = 30, so the sprite's on-screen position is unchanged on expand.
    expect(coll.y + (120 - 16 - 88)).toBe(exp.y + 16)
  })
  it('keeps the window bottom (sprite) fixed when expanding UP', () => {
    const coll = resolvePetLayout(WA, { corner: 'right', free: { x: 500, y: 500 } }, false, 24)
    const exp = resolvePetLayout(WA, { corner: 'right', free: { x: 500, y: 500 } }, true, 24)
    expect(coll.y + coll.height).toBe(exp.y + exp.height)
  })
})

// Multi-monitor: `free` holds ABSOLUTE global screen coordinates (not workArea-relative). The caller
// resolves which display the free point lives on and passes THAT display's region for clamping, so
// the pet can be dropped on a secondary monitor (whose region has a non-zero x/y origin) and stay
// there instead of being pulled back toward the primary display.
describe('resolvePetLayout — secondary monitor (non-zero origin region)', () => {
  const WA2 = { x: 1440, y: 0, width: 1920, height: 1080 } // monitor #2 sitting to the right of primary

  it('treats free as absolute screen coords (collapsed stays on monitor 2)', () => {
    expect(resolvePetLayout(WA2, { corner: 'right', free: { x: 1600, y: 300 } }, false, 24))
      .toEqual({ x: 1600, y: 300, width: 140, height: 120, vdir: 'up' })
  })

  it('clamps an overflowing free point to the SECONDARY display bounds (sprite-flush)', () => {
    expect(resolvePetLayout(WA2, { corner: 'right', free: { x: 99999, y: 99999 } }, false, 24))
      .toEqual({ x: 1440 + 1920 - 140 + 16, y: 1080 - 120 + 16, width: 140, height: 120, vdir: 'up' })
  })

  it('does NOT pull a monitor-2 free point back toward the primary origin', () => {
    // Regression for the old `workArea.x + free.x` baseline bug.
    const b = resolvePetLayout(WA2, { corner: 'left', free: { x: 1600, y: 300 } }, false, 24)
    expect(b.x).toBe(1600)
  })
})

describe('resolvePetLayout 气泡尺寸档', () => {
  const free = { x: 800, y: 600 }
  it('传入 PET_BUBBLE 时用紧凑尺寸(小于 PET_EXPANDED)', () => {
    const l = resolvePetLayout(WA, { corner: 'right', free }, true, 8, PET_BUBBLE)
    expect(l.width).toBe(PET_BUBBLE.width)
    expect(l.height).toBe(PET_BUBBLE.height)
  })
  it('不传 expandedSize 时回退到完整放大尺寸(back-compat)', () => {
    const l = resolvePetLayout(WA, { corner: 'right', free }, true, 8)
    expect(l.width).toBe(360)  // PET_EXPANDED.width
  })
  it('collapsed 不受影响', () => {
    const l = resolvePetLayout(WA, { corner: 'right', free }, false, 8, PET_BUBBLE)
    expect(l.width).toBe(PET_COLLAPSED.width)
  })
})

// ===== 宠物缩放(scale)参数化 =====
describe('pet scale — sizing helpers', () => {
  it('clampPetScale clamps into [0.6, 1.8] and falls back to 1 for junk', () => {
    expect(PET_SCALE_MIN).toBe(0.6)
    expect(PET_SCALE_MAX).toBe(1.8)
    expect(clampPetScale(1.2)).toBe(1.2)
    expect(clampPetScale(0.1)).toBe(0.6)
    expect(clampPetScale(5)).toBe(1.8)
    expect(clampPetScale(NaN)).toBe(1)
    expect(clampPetScale(undefined)).toBe(1)
    expect(clampPetScale('big' as unknown)).toBe(1)
  })
  it('petSpriteSize scales the 88px sprite (rounded)', () => {
    expect(petSpriteSize()).toBe(88)
    expect(petSpriteSize(1)).toBe(88)
    expect(petSpriteSize(1.5)).toBe(132)
    expect(petSpriteSize(0.6)).toBe(53) // round(52.8)
  })
  it('petCollapsedSize keeps the fixed 16px insets around the scaled sprite', () => {
    expect(petCollapsedSize(1)).toEqual(PET_COLLAPSED) // scale=1 回归现值
    expect(petCollapsedSize(1.5)).toEqual({ width: 184, height: 164 }) // +44 sprite delta
    expect(petCollapsedSize(0.6)).toEqual({ width: 105, height: 85 })  // -35 sprite delta
  })
  it('petPopupSize grows popup windows by the sprite delta but never shrinks below base', () => {
    expect(petPopupSize(PET_EXPANDED, 1)).toEqual(PET_EXPANDED)
    expect(petPopupSize(PET_EXPANDED, 1.5)).toEqual({ width: 360, height: 604 })
    expect(petPopupSize(PET_BUBBLE, 1.5)).toEqual({ width: 340, height: 264 })
    expect(petPopupSize(PET_EXPANDED, 0.6)).toEqual(PET_EXPANDED) // 缩小时不缩窗,弹窗内容不缩
  })
})

// ===== 缩放拖动预扩窗(live 阶段窗口零重排) =====
describe('pet resize 预扩窗 — petMaxSize / petResizeFootprint', () => {
  it('petMaxSize:各模式按 PET_SCALE_MAX(1.8) 的最大足迹', () => {
    // sprite delta @1.8 = round(88*1.8) - 88 = 70
    expect(petMaxSize('collapsed')).toEqual(petCollapsedSize(PET_SCALE_MAX))
    expect(petMaxSize('collapsed')).toEqual({ width: 210, height: 190 })
    expect(petMaxSize('bubble')).toEqual(petPopupSize(PET_BUBBLE, PET_SCALE_MAX))
    expect(petMaxSize('bubble')).toEqual({ width: 340, height: 290 })
    expect(petMaxSize('expanded')).toEqual(petPopupSize(PET_EXPANDED, PET_SCALE_MAX))
    expect(petMaxSize('expanded')).toEqual({ width: 360, height: 630 })
  })
  it('right + up:扩窗保持窗口左上角不动,向右下角外扩(符合右下手柄直觉)', () => {
    const l = { x: 1200, y: 700, width: 140, height: 120, vdir: 'up' as const }
    const b = petResizeFootprint(l, 'right', { width: 210, height: 190 })
    expect(b).toEqual({ x: 1200, y: 700, width: 210, height: 190 })
    expect(b.x).toBe(l.x)
    expect(b.y).toBe(l.y)
  })
  it('left + up:同样保持左上角不动', () => {
    const l = { x: 8, y: 700, width: 140, height: 120, vdir: 'up' as const }
    const b = petResizeFootprint(l, 'left', { width: 210, height: 190 })
    expect(b).toEqual({ x: 8, y: 700, width: 210, height: 190 })
  })
  it('vdir=down(弹层朝下,精灵锚在窗口顶部):保持顶边不动,向下扩', () => {
    const l = { x: 500, y: 100, width: 340, height: 220, vdir: 'down' as const }
    expect(petResizeFootprint(l, 'right', { width: 340, height: 290 }))
      .toEqual({ x: 500, y: 100, width: 340, height: 290 })
    expect(petResizeFootprint(l, 'left', { width: 340, height: 290 }))
      .toEqual({ x: 500, y: 100, width: 340, height: 290 })
  })
  it('已是最大 scale 时扩窗是恒等操作(尺寸相同 → 原地不动)', () => {
    const l = { x: 100, y: 200, width: 210, height: 190, vdir: 'up' as const }
    expect(petResizeFootprint(l, 'right', { width: 210, height: 190 })).toEqual({ x: 100, y: 200, width: 210, height: 190 })
  })
})

describe('resolvePetLayout / clampPetSprite / freeFromWindow with scale', () => {
  it('collapsed window uses the scaled collapsed size', () => {
    expect(resolvePetLayout(WA, { corner: 'right', free: { x: 300, y: 200 } }, false, 24, PET_EXPANDED, 1.5))
      .toEqual({ x: 300, y: 200, width: 184, height: 164, vdir: 'up' })
  })
  it('clamps the SCALED sprite flush to the work-area edge', () => {
    // window may overflow by the fixed 16px side/bottom insets: x=1000-184+16=832, y=800-164+16=652
    expect(resolvePetLayout(WA, { corner: 'right', free: { x: 9999, y: 9999 } }, false, 24, PET_EXPANDED, 1.5))
      .toEqual({ x: 832, y: 652, width: 184, height: 164, vdir: 'up' })
  })
  it('expands UP at scale 1.5 keeping the sprite bottom fixed', () => {
    const size = petPopupSize(PET_EXPANDED, 1.5) // 360×604
    const exp = resolvePetLayout(WA, { corner: 'right', free: { x: 500, y: 500 } }, true, 24, size, 1.5)
    expect(exp).toEqual({ x: 324, y: 60, width: 360, height: 604, vdir: 'up' })
    // collapsed bottom 500+164 === expanded bottom 60+604
    expect(exp.y + exp.height).toBe(500 + petCollapsedSize(1.5).height)
  })
  it('freeFromWindow round-trips the scaled expanded window back to the free baseline', () => {
    const size = petPopupSize(PET_EXPANDED, 1.5)
    const exp = resolvePetLayout(WA, { corner: 'right', free: { x: 500, y: 500 } }, true, 24, size, 1.5)
    expect(freeFromWindow(exp.x, exp.y, exp.width, exp.height, 'right', 'up', 1.5)).toEqual({ x: 500, y: 500 })
  })
  it('clampPetSprite accounts for the scaled sprite dead-space', () => {
    // collapsed@1.5 = 184×164, topInset = 164-16-132 = 16 (scale-invariant by construction)
    expect(clampPetSprite(300, -1000, petCollapsedSize(1.5), WA, 1.5)).toEqual({ x: 300, y: WA.y - 16 })
  })
  it('relocatePetToRegion honors the scaled collapsed size', () => {
    const A = { x: 0, y: 0, width: 1000, height: 800 }
    const B = { x: 1000, y: 0, width: 1000, height: 800 }
    const free = { x: A.width - petCollapsedSize(1.5).width, y: 0 }
    const out = relocatePetToRegion(free, A, B, 1.5)
    expect(out.x).toBeGreaterThan(B.x + B.width - petCollapsedSize(1.5).width - 40)
    expect(out.x).toBeLessThanOrEqual(B.x + B.width)
  })
})

// freeFromWindow is the inverse of resolvePetLayout — dropping the pet after a drag must recover the
// SAME free position, whether the pet was dragged collapsed or while the popup was open (up OR down).
describe('freeFromWindow ↔ resolvePetLayout round-trip', () => {
  it('recovers the free top-left from an UP-expanded window', () => {
    const exp = resolvePetLayout(WA, { corner: 'right', free: { x: 500, y: 500 } }, true, 24) // {280,60,360,560,up}
    expect(freeFromWindow(exp.x, exp.y, exp.width, exp.height, 'right', 'up')).toEqual({ x: 500, y: 500 })
  })
  it('recovers the free top-left from a DOWN-expanded window (sprite at the top)', () => {
    const exp = resolvePetLayout(WA, { corner: 'right', free: { x: 500, y: 30 } }, true, 24) // {280,30,360,560,down}
    expect(freeFromWindow(exp.x, exp.y, exp.width, exp.height, 'right', 'down')).toEqual({ x: 500, y: 30 })
  })
  it('is identity for a collapsed window (vdir up)', () => {
    expect(freeFromWindow(640, 720, 140, 120, 'left', 'up')).toEqual({ x: 640, y: 720 })
  })
})
