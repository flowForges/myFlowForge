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
import { TEXT_SCALE, loadPrefs, parseTextSize, parseThemePref, savePrefs } from './prefs'

beforeEach(() => store.clear())

describe('外观偏好', () => {
  it('认不出来的主题一律退回跟随系统 —— 降级/手改坏了不能让人对着一屏白字', () => {
    expect(parseThemePref('dark')).toBe('dark')
    expect(parseThemePref('light')).toBe('light')
    expect(parseThemePref('system')).toBe('system')
    expect(parseThemePref('浅')).toBe('system')
    expect(parseThemePref(undefined)).toBe('system')
    expect(parseThemePref(3)).toBe('system')
  })

  it('认不出来的字号一律退回标准', () => {
    expect(parseTextSize('sm')).toBe('sm')
    expect(parseTextSize('md')).toBe('md')
    expect(parseTextSize('lg')).toBe('lg')
    expect(parseTextSize('huge')).toBe('md')
    expect(parseTextSize(null)).toBe('md')
  })

  it('★三档字号必须真的不一样,而且是单调的 —— 三个都写成 1 也能「全绿」', () => {
    // ★这条是**故意**加的:倍率三档全写成 1.0 的话界面上什么都不会变(选了「大」也不变大),
    //  而上面每一条测试照样绿。所以必须在这儿钉住「真的不一样」和「方向没搞反」。
    expect(TEXT_SCALE.sm).toBeLessThan(TEXT_SCALE.md)
    expect(TEXT_SCALE.md).toBeLessThan(TEXT_SCALE.lg)
    // 标准档必须正好是 1:`T` 靠 `scale === 1` 走那条不做 flatten 的快路径,
    // 这里写成 0.999 会让绝大多数人白白多一次 flatten,而且没有任何别的地方会报错。
    expect(TEXT_SCALE.md).toBe(1)
  })

  it('存进去读得回来', async () => {
    await savePrefs({ theme: 'light', text: 'lg' })
    expect(await loadPrefs()).toEqual({ theme: 'light', text: 'lg' })
  })

  it('没存过时是两个默认', async () => {
    expect(await loadPrefs()).toEqual({ theme: 'system', text: 'md' })
  })

  it('★存坏了(不是 JSON)读回默认,不抛 —— 这一屏是「加主机」和「清数据」的唯一入口,不能因为它炸掉', async () => {
    store.set('mff.prefs.v1', '{坏的')
    expect(await loadPrefs()).toEqual({ theme: 'system', text: 'md' })
  })

  it('★存成了别的形状时逐字段兜底,坏的那个才退默认 —— 别因为一个字段坏了把另一个也丢掉', async () => {
    store.set('mff.prefs.v1', '{"theme":"dark","text":"huge"}')
    expect(await loadPrefs()).toEqual({ theme: 'dark', text: 'md' })
    store.set('mff.prefs.v1', '["dark","lg"]')
    expect(await loadPrefs()).toEqual({ theme: 'system', text: 'md' })
    store.set('mff.prefs.v1', 'null')
    expect(await loadPrefs()).toEqual({ theme: 'system', text: 'md' })
  })
})
