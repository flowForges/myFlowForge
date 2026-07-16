// Heading from the pet toward the cursor, with 000 = up / 12 o'clock and increasing clockwise (matching
// the Codex look-direction rows). Returns null when the cursor is essentially over the pet (deadzone),
// so the caller falls back to the idle animation instead of a jittery gaze.
export function gazeAngle(
  petCenter: { x: number; y: number },
  cursor: { x: number; y: number },
  deadzonePx = 24,
): number | null {
  const dx = cursor.x - petCenter.x
  const dy = cursor.y - petCenter.y
  if (Math.hypot(dx, dy) <= deadzonePx) return null
  // atan2(dx, -dy): up (dx=0,dy<0)→0, right→90, down→180, left→270.
  return ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360
}
