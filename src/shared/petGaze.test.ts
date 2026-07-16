import { describe, it, expect } from 'vitest'
import { gazeAngle } from './petGaze'

const c = { x: 100, y: 100 }
describe('gazeAngle (000 = up, clockwise)', () => {
  it('cursor directly above → 0°', () => expect(gazeAngle(c, { x: 100, y: 0 })).toBe(0))
  it('cursor to the right → 90°', () => expect(gazeAngle(c, { x: 200, y: 100 })).toBe(90))
  it('cursor below → 180°', () => expect(gazeAngle(c, { x: 100, y: 200 })).toBe(180))
  it('cursor to the left → 270°', () => expect(gazeAngle(c, { x: 0, y: 100 })).toBe(270))
  it('null inside the deadzone', () => expect(gazeAngle(c, { x: 104, y: 103 }, 20)).toBeNull())
})
