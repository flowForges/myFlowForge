import { describe, it, expect, beforeEach, vi } from 'vitest'
// ★同 localData.test.ts:AsyncStorage 一 import 就把 react-native 整个拖进来,node 项目下必须 mock。
const store = new Map<string, string>()
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => { store.set(k, v) },
    removeItem: async (k: string) => { store.delete(k) },
  },
}))
import { hostLabel, loadHosts, saveHosts, type MobileHost } from './hosts'

const HOSTS_KEY = 'mff.hosts.v1'

const FULL: MobileHost = {
  id: 'h1',
  label: '书房的 Mac',
  url: 'ws://192.168.1.10:6789',
  token: 'tok',
  icon: '🖥️',
  lastConnectedAt: 17,
  pubKey: `${'A'.repeat(43)}=`,
  relay: 'wss://relay.example/',
}

beforeEach(() => store.clear())

/**
 * 主机改名(`conn.renameHost` → `hostLabel`)。名字**纯本地**:存在这台手机上,不发给那台电脑。
 * 配对码里的 `n` 只是个初值(通常是机器名),而「我该切到哪台」这个问题的答案本来就因人而异。
 */
describe('主机的显示名', () => {
  it('填了什么就是什么,首尾空白去掉', () => {
    expect(hostLabel('  书房的 Mac  ', 'ws://1.2.3.4:6789')).toBe('书房的 Mac')
  })

  it('★改成空的不是「没名字」,是回落成地址 —— 这是一个合法的选择,不该被拦下来', () => {
    expect(hostLabel('', 'ws://1.2.3.4:6789')).toBe('1.2.3.4:6789')
    expect(hostLabel('   ', 'ws://1.2.3.4:6789')).toBe('1.2.3.4:6789')
  })

  it('★回落的地址不带 scheme —— `ws://` 每一行都一样,占的是最值钱的开头几个字', () => {
    expect(hostLabel('', 'wss://relay.example.com:443')).toBe('relay.example.com:443')
  })
})

describe('主机存盘', () => {
  /**
   * ★★2026-08-31:`loadHosts` 的逐字段兜底 **漏了 `pubKey` 和 `relay`**。
   *  它俩是第三期(端到端加密 + 中转)加的,运行时一直在用(`conn.tsx` 拿它们决定走哪条链路),
   *  但**读盘那一趟把它们丢了** —— 于是「配好的中转主机杀进程重开之后退回明文直连、
   *  然后连不上」,而界面上只写着「连接失败」。这条链路刚在真机上验通过,
   *  而验的是**同一次运行**里的内存,重启这一路从来没人走过。
   */
  it('★中转主机重开 app 之后仍然是中转主机 —— pubKey 和 relay 不能在读盘时被丢掉', async () => {
    await saveHosts([FULL])
    const back = await loadHosts()
    expect(back).toEqual([FULL])
  })

  it('老记录没有这两个字段时保持没有,不要凭空补出空串', async () => {
    // 空串和 undefined 在下游是**两件事**:`hostClient` 判的是「有没有」,
    // 一个空串的 relay 会让它以为该走中转,然后拨一个空地址。
    store.set(HOSTS_KEY, JSON.stringify([{ id: 'h1', label: 'a', url: 'ws://1.2.3.4:6789', token: 't' }]))
    const back = await loadHosts()
    expect(back[0].pubKey).toBeUndefined()
    expect(back[0].relay).toBeUndefined()
  })

  it('★盘上是空串也要落成 undefined —— 空串的 relay 会让下游以为该走中转,然后去拨一个空地址', async () => {
    // 变异测试抓到的:只喂「缺字段」和「类型不对」两种,`typeof === 'string' ? h.relay : undefined`
    // 这种写法照样全绿,而它会把空串原样放行。
    store.set(HOSTS_KEY, JSON.stringify([
      { id: 'h1', label: 'a', url: 'ws://1.2.3.4:6789', token: 't', pubKey: '', relay: '' },
    ]))
    const back = await loadHosts()
    expect(back[0].pubKey).toBeUndefined()
    expect(back[0].relay).toBeUndefined()
  })

  it('盘上写着别的类型时按字段丢掉,不整份丢掉 —— 整份丢掉等于用户配的主机凭空消失', async () => {
    store.set(HOSTS_KEY, JSON.stringify([
      { id: 'h1', label: 'a', url: 'ws://1.2.3.4:6789', token: 't', pubKey: 42, relay: { nope: 1 } },
    ]))
    const back = await loadHosts()
    expect(back).toHaveLength(1)
    expect(back[0].pubKey).toBeUndefined()
    expect(back[0].relay).toBeUndefined()
  })

  it('label 缺了就用地址顶上 —— 一行没有名字的主机在列表里认不出来', async () => {
    store.set(HOSTS_KEY, JSON.stringify([{ id: 'h1', url: 'ws://1.2.3.4:6789' }]))
    expect((await loadHosts())[0].label).toBe('1.2.3.4:6789')
  })

  it('盘上是一团乱码就当没有主机,不要把整个 app 炸掉', async () => {
    store.set(HOSTS_KEY, '{not json')
    expect(await loadHosts()).toEqual([])
  })
})
