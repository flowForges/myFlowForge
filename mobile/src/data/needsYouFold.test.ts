import { describe, it, expect, vi, beforeEach } from 'vitest'
// ★必须 mock:AsyncStorage 一 import 就把 react-native 拖进来,而这套测试跑在 node 项目下
//  (见根 vitest.config.ts 的 mobile project)。同 expanded.test.ts。
const store = new Map<string, string>()
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => { store.set(k, v) },
  },
}))
import { loadNeedsYouFolded, saveNeedsYouFolded } from './needsYouFold'

beforeEach(() => store.clear())

describe('「需要你」折叠状态的持久化', () => {
  it('存进去读得回来(两个方向都要,只测一个方向的话写死 return 也能绿)', async () => {
    await saveNeedsYouFolded(true)
    expect(await loadNeedsYouFolded()).toBe(true)
    await saveNeedsYouFolded(false)
    expect(await loadNeedsYouFolded()).toBe(false)
  })

  it('没存过 = 展开', async () => {
    expect(await loadNeedsYouFolded()).toBe(false)
  })

  it('★★存的东西坏了/是别的形状时一律当**展开** —— 绝不能因为存储坏了就替人把门藏起来', async () => {
    for (const bad of ['{坏的', '"true"', '1', '{}', '[]', 'null']) {
      store.set('mff.needsYouFolded.v1', bad)
      expect(await loadNeedsYouFolded()).toBe(false)
    }
  })

  it('key 带 mff. 前缀,否则「清除本地数据」会漏掉它', async () => {
    await saveNeedsYouFolded(true)
    expect([...store.keys()]).toEqual(['mff.needsYouFolded.v1'])
  })
})
