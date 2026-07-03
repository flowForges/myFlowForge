import { describe, it, expect } from 'vitest'
import { reorder } from './reorder'

describe('reorder', () => {
  it('moves the dragged id into the drop target slot (drag down)', () => {
    // Drop A onto C → A lands just before C's old position: B, C, A, D? No —
    // removing A first shifts; A takes C's slot → B, A... let's assert concretely.
    expect(reorder(['A', 'B', 'C', 'D'], 'A', 'C')).toEqual(['B', 'A', 'C', 'D'])
  })

  it('moves the dragged id into the drop target slot (drag up)', () => {
    expect(reorder(['A', 'B', 'C', 'D'], 'D', 'B')).toEqual(['A', 'D', 'B', 'C'])
  })

  it('is a no-op when dragging an id onto itself', () => {
    expect(reorder(['A', 'B', 'C'], 'B', 'B')).toEqual(['A', 'B', 'C'])
  })

  it('is a no-op when the dragged id is unknown', () => {
    expect(reorder(['A', 'B', 'C'], 'X', 'B')).toEqual(['A', 'B', 'C'])
  })

  it('is a no-op when the drop target is unknown', () => {
    expect(reorder(['A', 'B', 'C'], 'A', 'X')).toEqual(['A', 'B', 'C'])
  })

  it('does not mutate the input array', () => {
    const input = ['A', 'B', 'C']
    reorder(input, 'A', 'C')
    expect(input).toEqual(['A', 'B', 'C'])
  })
})
