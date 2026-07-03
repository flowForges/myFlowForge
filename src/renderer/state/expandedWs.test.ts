import { describe, it, expect, beforeEach } from 'vitest'
import { toggleExpanded, loadExpanded, saveExpanded } from './expandedWs'

beforeEach(() => { (globalThis as any).localStorage = { _d: {} as Record<string,string>, getItem(k:string){return this._d[k]??null}, setItem(k:string,v:string){this._d[k]=v} } })

describe('expandedWs utils', () => {
  it('toggle adds then removes', () => {
    let s = new Set<string>()
    s = toggleExpanded(s, '/w1'); expect(s.has('/w1')).toBe(true)
    s = toggleExpanded(s, '/w1'); expect(s.has('/w1')).toBe(false)
  })
  it('save then load round-trips', () => {
    saveExpanded(['/w1', '/w2'])
    expect(loadExpanded().sort()).toEqual(['/w1', '/w2'])
  })
})
