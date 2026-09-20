import { describe, it, expect, vi, beforeEach } from 'vitest'
// ★必须 mock:AsyncStorage 一 import 就把 react-native 拖进来,而这套测试跑在 node 项目下
//  (见根 vitest.config.ts 的 mobile project),带 RN 的东西在这儿根本 import 不动。
const store = new Map<string, string>()
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => { store.set(k, v) },
  },
}))
import { loadExpanded, saveExpanded } from './expanded'

beforeEach(() => store.clear())

describe('expanded 持久化', () => {
  it('存进去读得回来', async () => {
    await saveExpanded(['/w1', '/w2'])
    expect((await loadExpanded()).sort()).toEqual(['/w1', '/w2'])
  })
  it('没存过时是空的', async () => { expect(await loadExpanded()).toEqual([]) })
  it('★存的东西坏了(不是 JSON)时返回空,不抛 —— 这一屏不能因为它炸掉', async () => {
    store.set('mff.expandedWs.v1', '{坏的')
    expect(await loadExpanded()).toEqual([])
  })
  it('★存成了别的形状(对象 / 里面混着数字)时只收字符串', async () => {
    store.set('mff.expandedWs.v1', '{"a":1}')
    expect(await loadExpanded()).toEqual([])
    store.set('mff.expandedWs.v1', '["/w1",3,null,"/w2"]')
    expect((await loadExpanded()).sort()).toEqual(['/w1', '/w2'])
  })
})
