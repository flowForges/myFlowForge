import { describe, it, expect } from 'vitest'
import {
  PALETTE_PROPS, TUNING, extractPalette, hueGap, maxChromaAt, paletteSwatches, paletteVars,
  srgbToOklch, wallpaperSourceFor, type WallpaperPalette,
} from './wallpaperPalette'
import type { Appearance } from '@shared/types'

// 把 "#rrggbb" 展开成 n 个像素的 RGBA;拼起来就是一张「合成壁纸」,不需要真 canvas。
function fill(hex: string, n: number, alpha = 255): number[] {
  const v = parseInt(hex.slice(1), 16)
  const px = [(v >> 16) & 255, (v >> 8) & 255, v & 255, alpha]
  return Array.from({ length: n }, () => px).flat()
}
const img = (...parts: number[][]) => new Uint8ClampedArray(parts.flat())

const hueOf = (hex: string) => srgbToOklch(...(fill(hex, 1).slice(0, 3) as [number, number, number])).h

describe('srgbToOklch', () => {
  it('白/黑是无彩色,明度落在两端', () => {
    const w = srgbToOklch(255, 255, 255)
    const k = srgbToOklch(0, 0, 0)
    expect(w.L).toBeCloseTo(1, 2)
    expect(w.C).toBeLessThan(0.002)
    expect(k.L).toBeCloseTo(0, 2)
  })

  it('中性灰的彩度接近 0,饱和色的彩度明显更高', () => {
    expect(srgbToOklch(128, 128, 128).C).toBeLessThan(0.002)
    expect(srgbToOklch(255, 0, 0).C).toBeGreaterThan(0.2)
  })

  it('色相角能区分红/绿/蓝', () => {
    const r = srgbToOklch(255, 0, 0).h
    const g = srgbToOklch(0, 255, 0).h
    const b = srgbToOklch(0, 0, 255).h
    expect(hueGap(r, g)).toBeGreaterThan(60)
    expect(hueGap(g, b)).toBeGreaterThan(60)
    expect(hueGap(r, b)).toBeGreaterThan(60)
  })
})

describe('hueGap', () => {
  it('走色环短边,跨 0° 不会算成 350°', () => {
    expect(hueGap(10, 350)).toBeCloseTo(20, 5)
    expect(hueGap(350, 10)).toBeCloseTo(20, 5)
    expect(hueGap(0, 180)).toBeCloseTo(180, 5)
  })
})

describe('extractPalette · 基调判定', () => {
  it('暗壁纸 → dark', () => {
    expect(extractPalette(img(fill('#101828', 100)))!.base).toBe('dark')
  })

  it('亮壁纸 → light', () => {
    expect(extractPalette(img(fill('#eef2ff', 100)))!.base).toBe('light')
  })

  it('空输入返回 null', () => {
    expect(extractPalette(new Uint8ClampedArray(0))).toBeNull()
  })

  it('全透明像素不参与统计 → 返回 null 而不是把透明当黑色', () => {
    expect(extractPalette(img(fill('#ff0000', 50, 0)))).toBeNull()
  })
})

describe('extractPalette · 取色', () => {
  it('单色壁纸:主调=该色相,点缀色退化成同色相', () => {
    const p = extractPalette(img(fill('#1d4ed8', 200)))!
    expect(hueGap(p.hueBg, hueOf('#1d4ed8'))).toBeLessThan(10)
    expect(p.hueAccent).not.toBeNull()
    expect(p.hueAccent).toBe(p.hueBg)
  })

  it('大面积主调 + 小面积高饱和点缀:分别取到两个色相', () => {
    // 95% 深青绿 + 5% 亮橙 —— 就是「夕阳/霓虹」那种壁纸的最小模型。
    const p = extractPalette(img(fill('#0f6f6a', 950), fill('#ff7a1a', 50)))!
    expect(hueGap(p.hueBg, hueOf('#0f6f6a'))).toBeLessThan(15)
    expect(hueGap(p.hueAccent!, hueOf('#ff7a1a'))).toBeLessThan(15)
    expect(hueGap(p.hueBg, p.hueAccent!)).toBeGreaterThanOrEqual(TUNING.ACCENT_MIN_HUE_GAP)
  })

  it('点缀色面积太小(低于门槛)时不被选中,退化成单色相', () => {
    // 2 / 1002 ≈ 0.2%,远低于 ACCENT_MIN_SHARE → 当噪点丢掉。
    const p = extractPalette(img(fill('#0f6f6a', 1000), fill('#ff7a1a', 2)))!
    expect(p.hueAccent).toBe(p.hueBg)
  })

  // ---- 回归:真机上「粉发人物壁纸 → 青绿 accent」那个 bug。这张壁纸整个只有一个色系,过了门槛的
  //      全是 5% 上下的碎色,谁当选纯看噪声(前四名得分 0.0052/0.0051/0.0049/0.0047)。----
  it('★单色相壁纸不该硬凑第二色(碎色相对主调分量太小 → 回落主调)', () => {
    // 62% 的浓粉主调(C=0.169) + 三抹碎色(C≈0.058~0.067)。三抹碎色的实际彩度都在 0.05 以上,
    // 所以「面积/色距/实际彩度」三道旧门槛它们都过得了 —— 这条用例才真的打在新门槛上,而不是
    // 因为旧门槛顺手挡住了(那会是一条假绿)。它们的投票权重(ΣC²)只有主调的 2.5%~3.5%,不到 5%。
    const p = extractPalette(img(
      fill('#e8607a', 620),   // 主调:浓粉 C=0.169 → vote 17.8
      fill('#3c7278', 130),   // 青 C=0.058 → vote 0.44 = 主调的 2.5%
      fill('#60693c', 130),   // 黄 C=0.067 → vote 0.58 = 主调的 3.3%
      fill('#3f6f57', 120),   // 绿 C=0.066 → vote 0.52 = 主调的 2.9%
    ))!
    expect(hueGap(p.hueBg, hueOf('#e8607a'))).toBeLessThan(20)
    expect(p.hueAccent).toBe(p.hueBg)   // 回落主调,不去碎色里乱抓
  })

  it('★但主调旁边真有一抹够分量的第二色时照样选得中(门槛不能把好搭配一起挡掉)', () => {
    // 同样是浓粉主调,但青色这次面积大、彩度也高 —— 投票权重远超主调的 5%。
    const p = extractPalette(img(fill('#e8607a', 700), fill('#1f9fb5', 300)))!
    expect(hueGap(p.hueAccent!, hueOf('#1f9fb5'))).toBeLessThan(20)
  })

  // ---- 回归:真机上「绿裙人物壁纸 → 橙色 accent」那个 bug。根因是打分只问「这个色相最多能多鲜艳」,
  //      从不问「它在这张壁纸里实际有多鲜艳」,于是一大片近乎灰的肤色靠面积就赢了。----
  it('★大面积的近灰肤色抢不走 accent(30% 肤色 vs 70% 绿)', () => {
    // #e0c0aa 实际彩度只有 0.047 —— 比 COLORFUL_MIN_C(0.04)才高一点点,本质是带暖调的灰。
    // 它离绿色 78°(远超 45° 门槛)、面积 30%(远超 3% 门槛),旧规则下必被选中。
    const p = extractPalette(img(fill('#5f7f4a', 700), fill('#e0c0aa', 300)))!
    expect(hueGap(p.hueBg, hueOf('#5f7f4a'))).toBeLessThan(15)
    expect(hueGap(p.hueAccent!, hueOf('#e0c0aa'))).toBeGreaterThan(30)  // 不是肤色
    expect(p.hueAccent).toBe(p.hueBg)                                    // 退化成主调(绿)
  })

  it('★但真正饱和的第二色照样选得中(门槛不能把好色一起挡掉)', () => {
    // 把肤色换成真橙(实际彩度 0.187,远高于 ACCENT_MIN_AVG_C),面积 10%:仍远超 3% 面积门槛。
    // 面积不能给到 30% —— 主调是按 ΣC² 投票的,那么大一片高饱和橙会直接把主调夺走,角色就对调了。
    const p = extractPalette(img(fill('#5f7f4a', 900), fill('#ff7a1a', 100)))!
    expect(hueGap(p.hueBg, hueOf('#5f7f4a'))).toBeLessThan(15)
    expect(hueGap(p.hueAccent!, hueOf('#ff7a1a'))).toBeLessThan(15)
  })

  // ---- 回归:真机上「塞尔达青蓝天空壁纸 → 橄榄绿 accent」那个 bug(见 wallpaperPalette.ts 的取色注释)----
  it('★面积不足的碎片抢不走 accent(1.9% 的金色叶子 vs 36% 的青蓝天空)', () => {
    // 现场复刻:大面积浅青主调 + 一小撮高饱和金色。金色 maxC 更高,但只占 2%,不该定调整个 App。
    const p = extractPalette(img(fill('#7fd0e0', 980), fill('#f0c020', 20)))!
    expect(p.base).toBe('light')
    expect(hueGap(p.hueAccent!, hueOf('#f0c020'))).toBeGreaterThan(30)  // 不是金色
    expect(p.hueAccent).toBe(p.hueBg)                                    // 退化成主调
  })

  it('★同等面积下,在目标明度会变浑的暖色相输给能真正鲜艳的冷色相', () => {
    // 金色在图里更饱和(maxC 更大),但浅色底的 accent 明度是 56%,金色在那个明度下彩度上不去(必浑);
    // 蓝色则能吃满目标彩度。按「面积 × 可达彩度」打分,蓝色应胜出。
    const p = extractPalette(img(fill('#7fd0e0', 900), fill('#f0c020', 50), fill('#7a3fd0', 50)))!
    expect(p.base).toBe('light')
    expect(hueGap(p.hueAccent!, hueOf('#7a3fd0'))).toBeLessThan(25)
    expect(hueGap(p.hueAccent!, hueOf('#f0c020'))).toBeGreaterThan(60)
  })

  it('★点缀色必须与主调明显不同色相(相邻色调不算另一抹色)', () => {
    // 190° 主调 + 一片 40° 开外但不到 45° 的邻近色 → 不该被当点缀色。
    const p = extractPalette(img(fill('#0f6f6a', 800), fill('#0f7f4a', 200)))!
    expect(p.hueAccent).toBe(p.hueBg)
  })

  it('灰度壁纸:不取色相,强调色交还给用户(hueAccent=null)', () => {
    const p = extractPalette(img(fill('#1a1a1a', 400), fill('#8a8a8a', 300), fill('#d4d4d4', 300)))!
    expect(p.hueAccent).toBeNull()
    expect(p.chromaBg).toBe(0)
    expect(p.base).toBe('dark')
  })

  it('tint 彩度永远夹在调参区间内(哪怕壁纸是纯饱和色)', () => {
    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#1d4ed8', '#0f6f6a']) {
      const p = extractPalette(img(fill(hex, 200)))!
      expect(p.chromaBg).toBeGreaterThanOrEqual(TUNING.TINT_MIN)
      expect(p.chromaBg).toBeLessThanOrEqual(TUNING.TINT_MAX)
    }
  })
})

describe('paletteVars · 对比度护栏', () => {
  const dark: WallpaperPalette = { base: 'dark', hueBg: 264, chromaBg: 0.02, hueAccent: 40 }
  const light: WallpaperPalette = { base: 'light', hueBg: 90, chromaBg: 0.02, hueAccent: 300 }
  const L = (v: string) => Number(/oklch\(([\d.]+)%/.exec(v)![1])

  it('深色基调:明度阶梯照抄内置深色主题(底 20% / 侧栏 17% / 正文 95%)', () => {
    const v = paletteVars(dark)
    expect(L(v['--bg'])).toBe(20)
    expect(L(v['--sidebar'])).toBe(17)
    expect(L(v['--fg'])).toBe(95)
    // 次级文字必须显著亮于底色 —— 皮肤系统那轮 --muted/--faint 失明的坑就在这。
    expect(L(v['--muted'])).toBeGreaterThan(L(v['--bg']) + 30)
    expect(L(v['--faint'])).toBeGreaterThan(L(v['--bg']) + 20)
  })

  it('★深色次级文字亮度对齐 6 套内置皮肤的调优结果,而不是 tokens.css 的基础值', () => {
    // 壁纸模式下面板是半透明的,亮壁纸会把面板顶亮,tokens.css 基础深色的 muted 64 / faint 50 直接读不出。
    // 4 套内置深色皮肤真机调优后落在 muted 75.1–79.2、faint 63.3–67.3、fg-2 83.1–86.8 —— 取其下沿当底线。
    const v = paletteVars(dark)
    expect(L(v['--muted'])).toBeGreaterThanOrEqual(74)
    expect(L(v['--faint'])).toBeGreaterThanOrEqual(62)
    expect(L(v['--fg-2'])).toBeGreaterThanOrEqual(83)
  })

  it('★浅色次级文字不能比内置浅色皮肤更淡(浅底上太淡=失明)', () => {
    // ink / mossgarden 调优后 faint 落在 59.1 / 60.1;基础值 62 比它们还淡,在浅底上对比度不够。
    const v = paletteVars(light)
    expect(L(v['--faint'])).toBeLessThanOrEqual(60)
    expect(L(v['--muted'])).toBeLessThanOrEqual(52)
  })

  it('浅色基调:正文远暗于底色', () => {
    const v = paletteVars(light)
    expect(L(v['--bg'])).toBe(98)
    expect(L(v['--fg'])).toBe(24)
    expect(L(v['--muted'])).toBeLessThan(L(v['--bg']) - 30)
  })

  it('壁纸只能影响色相:所有中性色都用 hueBg,明度与彩度与壁纸无关', () => {
    const a = paletteVars({ base: 'dark', hueBg: 10, chromaBg: 0.02, hueAccent: 200 })
    const b = paletteVars({ base: 'dark', hueBg: 300, chromaBg: 0.02, hueAccent: 200 })
    expect(L(a['--bg'])).toBe(L(b['--bg']))
    expect(a['--bg']).toContain(' 10')
    expect(b['--bg']).toContain(' 300')
  })

  it('accent 落在与内置预设强调色相同的波段(深色 L72/C.15、浅色 L56/C.16)', () => {
    expect(paletteVars(dark)['--accent']).toBe('oklch(72% 0.15 40)')
    expect(paletteVars(light)['--accent']).toBe('oklch(56% 0.16 300)')
  })

  it('深色 accent 配深字、浅色 accent 配白字', () => {
    expect(paletteVars(dark)['--on-accent']).toContain('15%')
    expect(paletteVars(light)['--on-accent']).toBe('oklch(99% 0 0)')
  })

  it('灰度壁纸只产出中性色,不产出 accent 四件套', () => {
    const v = paletteVars({ base: 'dark', hueBg: 0, chromaBg: 0, hueAccent: null })
    expect(v['--bg']).toBeDefined()
    expect(v['--accent']).toBeUndefined()
    expect(v['--accent-dim']).toBeUndefined()
    expect(v['--run']).toBeUndefined()
    expect(v['--on-accent']).toBeUndefined()
  })

  it('★accent 的彩度被压到该色相在该明度下真正可达的范围内(不产出色域外的值)', () => {
    // 黄绿色相在浅色底的 56% 明度下达不到 0.16 —— 必须自己夹住,而不是丢给浏览器去压。
    const muddy = paletteVars({ base: 'light', hueBg: 200, chromaBg: 0.02, hueAccent: 95 })
    const c = Number(/oklch\([\d.]+% ([\d.]+)/.exec(muddy['--accent'])![1])
    expect(c).toBeLessThan(0.16)
    expect(maxChromaAt(0.56, 95)).toBeLessThan(0.16)
    // 蓝色相则能吃满目标彩度。
    expect(maxChromaAt(0.56, 280)).toBeGreaterThan(0.16)
    expect(paletteVars({ base: 'light', hueBg: 200, chromaBg: 0.02, hueAccent: 280 })['--accent']).toContain('0.16')
  })

  it('★边框必须是半透明的 fg 色,不能是实色(实色在壁纸上就是刺眼的硬黑线)', () => {
    // global.css:57-60 早就为壁纸模式把 --border 换成了半透明 fg 色,skins.css:153 对皮肤同理。
    // 内联变量优先级高过这两条规则,所以自动配色必须自己产出同样柔和的边框,否则等于把那个修复撤销了。
    for (const p of [dark, light]) {
      const v = paletteVars(p)
      expect(v['--border']).toMatch(/ \/ 0\.\d+\)$/)
      expect(v['--border-2']).toMatch(/ \/ 0\.\d+\)$/)
      // 用的是正文色(与底色反向)而不是一个更暗的实色 —— 深色基调下边框应基于亮的 --fg
      expect(L(v['--border'])).toBe(L(v['--fg']))
    }
  })

  it('PALETTE_PROPS 覆盖 paletteVars 可能产出的每一个属性(否则关掉开关会有残留)', () => {
    const emitted = new Set([...Object.keys(paletteVars(dark)), ...Object.keys(paletteVars(light))])
    for (const prop of emitted) expect(PALETTE_PROPS).toContain(prop)
  })

  it('色点预览给出四个可用颜色', () => {
    expect(paletteSwatches(dark)).toHaveLength(4)
    expect(paletteSwatches(dark).every(c => c.startsWith('oklch('))).toBe(true)
    // 灰度壁纸没有 accent,预览用 surface-2 兜底,不能是 undefined
    expect(paletteSwatches({ base: 'dark', hueBg: 0, chromaBg: 0, hueAccent: null }).every(Boolean)).toBe(true)
  })
})

describe('wallpaperSourceFor', () => {
  const a = (over: Partial<Appearance>) => ({
    bgImage: '', bgScope: 'off', homeBgImage: '', homeBgOn: false, ...over,
  } as Appearance)

  it('优先用应用/会话区背景图', () => {
    expect(wallpaperSourceFor(a({ bgImage: 'forge-bg://img/a.png', bgScope: 'app', homeBgImage: 'forge-bg://img/b.png', homeBgOn: true })))
      .toBe('forge-bg://img/a.png')
  })

  it('背景范围关掉时回落到首页背景图', () => {
    expect(wallpaperSourceFor(a({ bgImage: 'forge-bg://img/a.png', bgScope: 'off', homeBgImage: 'forge-bg://img/b.png', homeBgOn: true })))
      .toBe('forge-bg://img/b.png')
  })

  it('都没有(或首页开关关着)时返回空', () => {
    expect(wallpaperSourceFor(a({}))).toBe('')
    expect(wallpaperSourceFor(a({ homeBgImage: 'forge-bg://img/b.png', homeBgOn: false }))).toBe('')
    expect(wallpaperSourceFor(undefined)).toBe('')
  })
})
