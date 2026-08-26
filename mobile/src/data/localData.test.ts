import { describe, it, expect, vi, beforeEach } from 'vitest'
// ★同 expanded.test.ts:AsyncStorage 一 import 就把 react-native 拖进来,node 项目下必须 mock。
const store = new Map<string, string>()
// ★把 multiRemove 做成 spy:光看 store 的最终状态**分不出**「没东西可删」和「压根没调删除」——
//  两种情况下 store 都是空的。下面那条「不去调 multiRemove」的用例必须真的看见调用次数,
//  否则它的名字承诺的东西比它断言的多,而名字是别人唯一会读的部分。
const multiRemove = vi.fn(async (ks: string[]) => { ks.forEach((k) => store.delete(k)) })
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getAllKeys: async () => [...store.keys()],
    multiRemove: (ks: string[]) => multiRemove(ks),
  },
}))
import { clearLocalData } from './localData'

beforeEach(() => {
  store.clear()
  multiRemove.mockClear()
})

describe('清除本地数据', () => {
  it('★令牌和主机清单必须真的没了 —— 只清了一半的「清除」比不清更糟,人会据此把手机借出去', async () => {
    store.set('mff.hosts.v1', '[{"token":"secret"}]')
    store.set('mff.activeHost.v1', 'h1')
    await clearLocalData()
    expect(store.has('mff.hosts.v1')).toBe(false)
    expect(store.has('mff.activeHost.v1')).toBe(false)
  })

  it('★按前缀扫,新加的 key 自动跟着被清 —— 手写名单会被下一个 key 静默架空', async () => {
    store.set('mff.hosts.v1', '[]')
    // 这个 key 今天还不存在。名单式实现会把它留在手机上,而没有任何测试会红。
    store.set('mff.somethingAddedLater.v1', 'x')
    const removed = await clearLocalData()
    expect(removed.sort()).toEqual(['mff.hosts.v1', 'mff.somethingAddedLater.v1'])
    expect(store.size).toBe(0)
  })

  it('别人的 key 不动 —— 这个前缀是我们自己的命名空间,越界清掉的是别人的东西', async () => {
    store.set('mff.prefs.v1', '{}')
    store.set('expo.something', 'keep')
    store.set('other', 'keep')
    await clearLocalData()
    expect([...store.keys()].sort()).toEqual(['expo.something', 'other'])
  })

  it('什么都没存过时不炸,也不去调 multiRemove —— 白跑一趟存储不该发生', async () => {
    expect(await clearLocalData()).toEqual([])
    expect(multiRemove).not.toHaveBeenCalled()
  })

  it('有东西要删时**确实**调了一次 multiRemove,且只带自己的 key', async () => {
    store.set('mff.hosts.v1', '[]')
    store.set('other', 'keep')
    await clearLocalData()
    expect(multiRemove).toHaveBeenCalledTimes(1)
    expect(multiRemove).toHaveBeenCalledWith(['mff.hosts.v1'])
  })
})
