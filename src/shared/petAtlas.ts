// Codex V2 pet sprite-atlas contract (see docs/superpowers/specs/2026-07-16-codex-pet-alignment-design.md).
// Pure: no DOM, no I/O — safe to unit-test and to import from both main and renderer.

export const SPRITE_VERSION = 2

export type PetAction =
  | 'idle' | 'running-right' | 'running-left' | 'waving' | 'jumping'
  | 'failed' | 'waiting' | 'running' | 'review'

export const PET_ACTIONS: PetAction[] = [
  'idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review',
]

export const ATLAS = { cols: 8, rows: 11, cellW: 192, cellH: 208, width: 1536, height: 2288 } as const

export const ROW_OF: Record<PetAction, number> = {
  idle: 0, 'running-right': 1, 'running-left': 2, waving: 3, jumping: 4,
  failed: 5, waiting: 6, running: 7, review: 8,
}

// Per-frame durations in ms; array length = frame count for that action's row.
export const FRAME_DURATIONS: Record<PetAction, number[]> = {
  idle: [280, 110, 110, 140, 140, 320],
  'running-right': [120, 120, 120, 120, 120, 120, 120, 220],
  'running-left': [120, 120, 120, 120, 120, 120, 120, 220],
  waving: [140, 140, 140, 280],
  jumping: [140, 140, 140, 140, 280],
  failed: [140, 140, 140, 140, 140, 140, 140, 240],
  waiting: [150, 150, 150, 150, 150, 260],
  running: [120, 120, 120, 120, 120, 220],
  review: [150, 150, 150, 150, 150, 280],
}

// background-position for a cell in the cols×rows grid, paired with `background-size: 800% 1100%`.
// The Nth of M positions is N/(M-1)*100% (0% first, 100% last).
export function cellBackgroundPosition(col: number, row: number): { x: string; y: string } {
  return { x: `${(col / (ATLAS.cols - 1)) * 100}%`, y: `${(row / (ATLAS.rows - 1)) * 100}%` }
}

// Map a heading in degrees (000 = up / 12 o'clock, clockwise) to one of the 16 look cells on rows 9-10.
// 16 poses at 22.5° steps; index 0-7 → row 9 cols 0-7, index 8-15 → row 10 cols 0-7. The caller decides
// the center deadzone (cursor essentially over the pet → pass no angle and fall back to idle instead).
export function lookCellForAngle(deg: number): { col: number; row: number } {
  const norm = ((deg % 360) + 360) % 360
  const idx = Math.round(norm / 22.5) % 16
  return { col: idx % ATLAS.cols, row: 9 + Math.floor(idx / ATLAS.cols) }
}

// Degrade a desired action to one the atlas actually provides. Codex v2 always ships all 9 rows, so this
// is identity for well-formed packs; it exists to keep a hand-made / partial atlas from going blank.
const FALLBACK: Record<PetAction, PetAction[]> = {
  idle: [],
  running: ['idle'],
  'running-right': ['running', 'idle'],
  'running-left': ['running', 'idle'],
  waiting: ['idle'],
  review: ['running', 'idle'],
  failed: ['idle'],
  waving: ['idle'],
  jumping: ['idle'],
}
export function resolveAction(desired: PetAction, available: ReadonlySet<PetAction>): PetAction {
  if (available.has(desired)) return desired
  for (const next of FALLBACK[desired]) if (available.has(next)) return next
  return 'idle'
}
