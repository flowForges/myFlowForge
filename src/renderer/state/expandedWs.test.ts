import { describe, it, expect, beforeEach } from 'vitest'
import { loadExpanded, saveExpanded } from './expandedWs'

beforeEach(() => { (globalThis as any).localStorage = { _d: {} as Record<string,string>, getItem(k:string){return this._d[k]??null}, setItem(k:string,v:string){this._d[k]=v} } })

// toggle 那条搬去了 src/shared/ui/expanded.test.ts —— 纯 Set 运算现在两端共用同一份。
// 这里只剩持久化,它跟平台走(localStorage 是同步的,手机端那份是 AsyncStorage 异步的)。
describe('expandedWs utils', () => {
  it('save then load round-trips', () => {
    saveExpanded(['/w1', '/w2'])
    expect(loadExpanded().sort()).toEqual(['/w1', '/w2'])
  })
})
