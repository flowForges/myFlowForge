import { describe, it, expect } from 'vitest'
import { mapInlineStyle, mapColor, parseColor, toOklch } from './htmlStyle'

// 这里的核心不是「样式对不对」,而是「危险的东西出不去」。所以每个攻击样本都做过变异验证:把 htmlStyle.ts
// 里对应的那条白名单/DANGER 规则删掉,对应用例必须变红。(成长宠物那批的教训:守卫的测试删掉 11 个用例
// 仍然全绿 = 零覆盖。)

describe('parseColor', () => {
  it('认 #rgb / #rrggbb / rgb() / rgba() / 关键字', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255])
    expect(parseColor('#F5F5F5')).toEqual([245, 245, 245])
    expect(parseColor('rgb(17, 17, 17)')).toEqual([17, 17, 17])
    expect(parseColor('rgba(255, 0, 0, 0.5)')).toEqual([255, 0, 0])
    expect(parseColor('white')).toEqual([255, 255, 255])
  })
  it('认不出的写法返回 null(fail closed,不猜)', () => {
    expect(parseColor('color-mix(in oklch, red, blue)')).toBeNull()
    expect(parseColor('var(--evil)')).toBeNull()
    expect(parseColor('')).toBeNull()
    expect(parseColor('#gg')).toBeNull()
  })
})

describe('toOklch', () => {
  it('黑白灰的彩度接近 0、明度单调', () => {
    const black = toOklch(0, 0, 0)
    const mid = toOklch(128, 128, 128)
    const white = toOklch(255, 255, 255)
    expect(black.C).toBeLessThan(0.02)
    expect(mid.C).toBeLessThan(0.02)
    expect(white.C).toBeLessThan(0.02)
    expect(black.L).toBeLessThan(mid.L)
    expect(mid.L).toBeLessThan(white.L)
    expect(white.L).toBeGreaterThan(0.97)
  })
  it('饱和色的彩度明显大于阈值', () => {
    expect(toOklch(255, 0, 0).C).toBeGreaterThan(0.05)
    expect(toOklch(0, 128, 0).C).toBeGreaterThan(0.05)
  })
})

describe('mapColor —— 彩色按色相归到语义 token', () => {
  it('红→err、黄橙→warn、绿→ok、蓝紫→accent', () => {
    expect(mapColor('#dc2626', 'fg')).toBe('var(--err)')
    expect(mapColor('#d97706', 'border')).toBe('var(--warn)')
    expect(mapColor('#16a34a', 'fg')).toBe('var(--ok)')
    expect(mapColor('#2563eb', 'fg')).toBe('var(--accent)')
    expect(mapColor('#7c3aed', 'fg')).toBe('var(--accent)')
  })
  it('判不准的彩色塌到 accent,绝不猜成 warn/err(语义反转比单调糟)', () => {
    // 品红/青这类没有对应语义的颜色。
    expect(mapColor('#d946ef', 'fg')).toBe('var(--accent)')
  })
})

describe('mapColor —— 黑白灰按角色落到中性阶梯', () => {
  it('背景角色:越亮越靠近 surface', () => {
    expect(mapColor('#ffffff', 'bg')).toBe('var(--surface)')
    expect(mapColor('#f2f2f2', 'bg')).toBe('var(--bg-2)')
    expect(mapColor('#999999', 'bg')).toBe('var(--surface-2)')
    expect(mapColor('#111111', 'bg')).toBe('var(--bg)')
  })
  it('前景角色:越暗越靠近 fg', () => {
    expect(mapColor('#111111', 'fg')).toBe('var(--fg)')
    expect(mapColor('#555555', 'fg')).toBe('var(--fg-2)')
    expect(mapColor('#bbbbbb', 'fg')).toBe('var(--muted)')
  })
  it('边框角色一律 --border', () => {
    expect(mapColor('#dddddd', 'border')).toBe('var(--border)')
    expect(mapColor('#333333', 'border')).toBe('var(--border)')
  })
  it('transparent/inherit/currentColor 原样透传(本身不含字面色值)', () => {
    expect(mapColor('transparent', 'bg')).toBe('transparent')
    expect(mapColor('inherit', 'fg')).toBe('inherit')
    expect(mapColor('currentColor', 'fg')).toBe('currentColor')
  })
})

describe('mapInlineStyle —— 属性白名单', () => {
  it('放行排版类属性', () => {
    expect(mapInlineStyle('display: flex; gap: 12px; padding: 8px 12px')).toEqual({
      display: 'flex', gap: '12px', padding: '8px 12px',
    })
    expect(mapInlineStyle('border-radius:9px;max-width:100%;text-align:center')).toEqual({
      borderRadius: '9px', maxWidth: '100%', textAlign: 'center',
    })
  })

  it('丢弃 position/z-index —— fixed + 高 z-index 能盖住整个 app 做点击劫持', () => {
    const s = mapInlineStyle('position: fixed; top: 0; left: 0; z-index: 99999; width: 100%')
    expect(s).not.toHaveProperty('position')
    expect(s).not.toHaveProperty('zIndex')
    expect(s).not.toHaveProperty('top')
    expect(s).not.toHaveProperty('left')
    expect(s).toEqual({ width: '100%' })   // 同条 style 里的正常属性照常放行
  })

  it('丢弃 box-shadow —— 模型必写浅色阴影,深色皮肤下等于不存在', () => {
    expect(mapInlineStyle('box-shadow: 0 2px 8px rgba(0,0,0,0.1); padding: 4px')).toEqual({ padding: '4px' })
  })

  it('丢弃动画/滤镜/指针类属性', () => {
    const s = mapInlineStyle('transform: scale(2); opacity: 0.1; animation: x 1s; transition: all .3s; filter: blur(4px); backdrop-filter: blur(4px); pointer-events: none; cursor: pointer')
    expect(s).toEqual({})
  })

  it('丢弃完全没听说过的属性', () => {
    expect(mapInlineStyle('-webkit-user-modify: read-write; behavior: url(#x)')).toEqual({})
  })
})

describe('mapInlineStyle —— 危险值', () => {
  it('含 url() 的声明整条丢弃(外链是追踪信标 + 泄露出口 IP)', () => {
    expect(mapInlineStyle('background: url(http://evil.example/beacon.png)')).toEqual({})
    expect(mapInlineStyle('background-color: url(https://x/y)')).toEqual({})
    expect(mapInlineStyle('list-style: url(http://evil/x)')).toEqual({})
  })
  it('★ url() 在「值域宽松」的属性上也必须被 DANGER 拦住', () => {
    // 上面三条其实是被颜色解析器/关键字表 fail-closed 顺带挡下的 —— 变异验证时把 DANGER 的 url() 删掉
    // 它们依然全绿,等于 DANGER 这条规则零覆盖。grid 轨道定义的字符集 [a-z0-9%.,()\s/-] 恰好放行
    // `url(evil.png)`,只有 DANGER 能拦它。这条用例专门盯死那个洞。
    expect(mapInlineStyle('grid-template-columns: url(evil.png)')).toEqual({})
    expect(mapInlineStyle('grid-template-rows: url(x.png)')).toEqual({})
  })
  it('含 expression() / javascript: / @import 的声明整条丢弃', () => {
    expect(mapInlineStyle('width: expression(alert(1))')).toEqual({})
    expect(mapInlineStyle('background: javascript:alert(1)')).toEqual({})
    expect(mapInlineStyle('color: red; @import "http://evil/x.css"')).toHaveProperty('color')
  })
  it('反斜杠转义(用来绕过上面的字面量匹配)整条丢弃', () => {
    expect(mapInlineStyle('background: u\\rl(http://evil/x)')).toEqual({})
  })
  it('视口单位不放行 —— 一个卡片能撑满整屏', () => {
    expect(mapInlineStyle('width: 100vw; height: 100vh')).toEqual({})
  })
})

describe('mapInlineStyle —— 简写', () => {
  it('border 简写拆开,颜色段换成 var()', () => {
    expect(mapInlineStyle('border: 1px solid #e5e5e5')).toEqual({ border: '1px solid var(--border)' })
    expect(mapInlineStyle('border-left: 3px solid #d97706')).toEqual({ borderLeft: '3px solid var(--warn)' })
  })
  it('border 简写里认不出的段 → 整条丢弃', () => {
    expect(mapInlineStyle('border: 1px solid color-mix(in srgb, red, blue)')).toEqual({})
  })
  it('border: none 照常放行', () => {
    expect(mapInlineStyle('border: none')).toEqual({ border: 'none' })
  })
  it('background 简写只接纯颜色,渐变整条丢', () => {
    expect(mapInlineStyle('background: #fafafa')).toEqual({ background: 'var(--surface)' })
    expect(mapInlineStyle('background: linear-gradient(90deg, #fff, #000)')).toEqual({})
  })
})

describe('mapInlineStyle —— 数值收窄', () => {
  it('font-size 夹住上限,避免撑爆消息流', () => {
    expect(mapInlineStyle('font-size: 14px')).toEqual({ fontSize: '14px' })
    expect(mapInlineStyle('font-size: 200px')).toEqual({ fontSize: '32px' })
  })
  it('长度属性拒绝非法值', () => {
    expect(mapInlineStyle('padding: 8px 12px 4px 2px')).toEqual({ padding: '8px 12px 4px 2px' })
    expect(mapInlineStyle('padding: calc(100% - 10px)')).toEqual({})
    expect(mapInlineStyle('width: attr(data-x)')).toEqual({})
  })
  it('关键字属性只认名单内取值', () => {
    expect(mapInlineStyle('display: flex')).toEqual({ display: 'flex' })
    expect(mapInlineStyle('display: -webkit-box')).toEqual({})
    expect(mapInlineStyle('overflow: hidden')).toEqual({ overflow: 'hidden' })
  })
  it('grid 轨道定义放行 repeat()/minmax()/fr', () => {
    expect(mapInlineStyle('grid-template-columns: repeat(3, minmax(0, 1fr))'))
      .toEqual({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' })
  })
})

describe('★ 硬约束:输出里永远不含字面色值', () => {
  // 这是 D2 的机械化断言。PARSE_CACHE 按原文缓存 ReactNode、主题切换不失效,一旦这里漏出算好的色值,
  // 用户换皮肤后卡片会卡在旧配色且刷不掉。所以用一条覆盖式断言兜住所有颜色路径。
  const SAMPLES = [
    'color: #111; background: #fff; border: 1px solid #ddd',
    'background-color: rgb(240, 240, 240); color: rgba(17,17,17,0.9)',
    'border-left: 4px solid crimson; color: darkgreen',
    'background: white; color: black; border-color: silver',
    'color: #2563eb; background-color: #eff6ff; border: 2px dashed #93c5fd',
  ]
  it.each(SAMPLES)('%s', (css) => {
    const out = mapInlineStyle(css) as Record<string, string>
    const values = Object.values(out).join(' ')
    expect(values).not.toMatch(/#[0-9a-f]{3}/i)
    expect(values).not.toMatch(/rgba?\(/i)
    expect(values).not.toMatch(/oklch\(/i)
    expect(values).not.toMatch(/hsla?\(/i)
    // 颜色一定映射成了 var(--token)
    for (const [k, v] of Object.entries(out)) {
      if (/color|background|border/i.test(k)) expect(v).toMatch(/var\(--|none|transparent|inherit|currentColor|solid|dashed|px/)
    }
  })
})

describe('mapInlineStyle —— 杂项', () => {
  it('空串 / 畸形输入不炸', () => {
    expect(mapInlineStyle('')).toEqual({})
    expect(mapInlineStyle(';;;')).toEqual({})
    expect(mapInlineStyle('color')).toEqual({})
    expect(mapInlineStyle(':::')).toEqual({})
  })
  it('大小写和多余空白不影响识别', () => {
    expect(mapInlineStyle('  COLOR :  #FFFFFF  ')).toEqual({ color: 'var(--muted)' })
    expect(mapInlineStyle('Display:Flex')).toEqual({ display: 'flex' })
  })
})
