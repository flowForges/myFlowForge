import { describe, it, expect } from 'vitest'
import { mapInlineStyle } from './htmlStyle'

/**
 * 几何量化 —— 把模型写的尺寸吸附到阶梯上。
 *
 * ★★这是「框有时候有点乱」的机械原因(用户 2026-09-07 原话)。`htmlStyle` 早就把**颜色**
 *  一律映射成 `var(--token)`,却对**几何**放行:`border-radius` / `border-width` / `padding` /
 *  `gap` / `font-size` 走的是通用 LENGTH 正则,任何 px 值原样进来。于是模型这次写 6px 圆角、
 *  下次 14px,这张卡 1px 边、那张 3px,内边距 10 / 16 / 24 —— 同一段对话里两张卡不一样宽的边、
 *  不一样圆的角,而且都跟 app 自己的框对不上。
 *
 * 所以这里用**和颜色一模一样的招**:吸附到阶梯,绝不原样输出模型算出来的值。
 * ★理由也一模一样:markdown.tsx 的 PARSE_CACHE 按原文缓存 ReactNode,输出算好的值会被永久缓存住。
 * ★代价是模型精心排的 13px 内边距会变成 12px —— 这正是要的,一致性比模型的即兴品味值钱。
 */
const px = (css: string, key: string) => (mapInlineStyle(css) as Record<string, string>)[key]

describe('圆角吸附到 {0, 6, 10, 999}', () => {
  it('★邻近的值塌到同一档 —— 5/6/8 都变 6,10/12/14 都变 10', () => {
    for (const v of ['5px', '6px', '8px']) expect(px(`border-radius:${v}`, 'borderRadius'), v).toBe('6px')
    for (const v of ['10px', '12px', '14px']) expect(px(`border-radius:${v}`, 'borderRadius'), v).toBe('10px')
  })
  it('0 还是 0,超大的一律当药丸', () => {
    expect(px('border-radius:0', 'borderRadius')).toBe('0')
    expect(px('border-radius:999px', 'borderRadius')).toBe('999px')
    expect(px('border-radius:50%', 'borderRadius')).toBe('999px')
  })
})

describe('边框宽度一律 1px', () => {
  it('★2px / 3px 的边压成 1px —— 粗细不一是「乱」最直接的来源', () => {
    expect(px('border-width:3px', 'borderWidth')).toBe('1px')
    expect(px('border:2px solid #888', 'border')).toBe('1px solid var(--border)')
  })
  it('0 / none 保持不画', () => {
    expect(px('border-width:0', 'borderWidth')).toBe('0')
    expect(px('border:none', 'border')).toBe('none')
  })
})

describe('间距吸附到 8pt 阶梯', () => {
  it('★13px → 12px,18px → 16px,5px → 4px', () => {
    expect(px('padding:13px', 'padding')).toBe('12px')
    expect(px('margin-top:18px', 'marginTop')).toBe('16px')
    expect(px('gap:5px', 'gap')).toBe('4px')
  })
  it('★多值的每一段各自吸附(padding: 10px 14px 是常见写法)', () => {
    // 14 正好卡在 12 和 16 中间 → 取小的那档(见 snap 的注释:规则单一,往小走只会更紧凑)。
    expect(px('padding:10px 14px', 'padding')).toBe('8px 12px')
  })
  it('0 保持 0', () => {
    expect(px('padding:0', 'padding')).toBe('0')
  })
})

describe('字号吸附到会话区的字阶,并且跟着字号设置走', () => {
  it('★★输出 em 而不是 px —— 写死 px 的话,用户调「会话区字号」时 HTML 卡片纹丝不动', () => {
    const v = px('font-size:14px', 'fontSize')
    expect(v, `拿到的是 ${v}`).toMatch(/em$/)
  })
  it('相邻字号塌到同一档,超大的被夹住', () => {
    expect(px('font-size:12px', 'fontSize')).toBe(px('font-size:13px', 'fontSize'))
    expect(px('font-size:14px', 'fontSize')).toBe(px('font-size:15px', 'fontSize'))
    expect(px('font-size:200px', 'fontSize')).toBe(px('font-size:32px', 'fontSize'))
  })
})

describe('不该被量化的东西别动', () => {
  it('★宽高不吸附 —— 它们是布局意图(50% / 120px 的图标位),不是间距节奏', () => {
    expect(px('width:37px', 'width')).toBe('37px')
    expect(px('max-width:100%', 'maxWidth')).toBe('100%')
  })
  it('★颜色照旧只输出 token,一个字面色值都不许漏', () => {
    const out = JSON.stringify(mapInlineStyle('background:#fff;color:#111;border-color:#888'))
    expect(out).toContain('var(--')
    expect(out).not.toContain('#')
  })
  it('非 px 单位原样放行(em/rem/% 本来就跟着排版走)', () => {
    expect(px('padding:1em', 'padding')).toBe('1em')
  })
})
