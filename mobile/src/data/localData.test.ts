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
    multiGet: async (ks: string[]) => ks.map((k) => [k, store.get(k) ?? null]),
    removeItem: async (k: string) => { store.delete(k) },
  },
}))
import { byteLength, clearLocalData, removeLocalKey, sizesOf } from './localData'

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

describe('removeLocalKey —— 前缀不变式改由运行时兑现', () => {
  it('★★越界直接抛,不是静默忽略', async () => {
    // `storageKeys.test.ts` 那条静态守卫认不出变量 key,它接受的是**这句断言存在**。
    // 所以断言真的会抛这件事,必须在这儿钉住 —— 否则那条守卫认的是一句没有效力的注释。
    await expect(removeLocalKey('other.thing')).rejects.toThrow(/不以 mff\. 开头/)
    await expect(removeLocalKey('')).rejects.toThrow()
  })

  it('自家命名空间内的照常删', async () => {
    await expect(removeLocalKey('mff.prefs.v1')).resolves.toBeUndefined()
  })
})

describe('byteLength', () => {
  it('按 UTF-8 算,中文 3 字节、emoji 4 字节', () => {
    expect(byteLength('')).toBe(0)
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('中')).toBe(3)
    expect(byteLength('🖥')).toBe(4)
    expect(byteLength('a中🖥')).toBe(8)
  })
})
