/**
 * 每个编码代理的**视觉身份**:一个字形 + 一层淡底 + 一个字色。
 *
 * ## ★★为什么手机端需要这个
 *
 * 2026-08-29 真机反馈:「手机端切换 provider 没有 mac 的那个提示和效果」。
 * 核实下来「提示」(切换时插进对话流的那条分割线)手机端**早就有了**,而且和电脑端同一套规则
 * (`providerSwitch.ts`);缺的是「效果」—— 电脑端的 composer 上,当前代理和菜单里每一项
 * 都带着一枚**品牌色的字形徽章**(`Composer.tsx` 的 `mc-logo-sm`),余光扫过去就知道现在是谁在答。
 * 手机端顶栏只有一行纯文字,换了代理只是那几个字变了。
 *
 * ## ★★为什么是**抄一份**而不是共用 `@shared/providerCatalog`
 *
 * 共用不了:那份文件里的颜色是 CSS 的 `oklch(60% .14 35 / .18)` 字符串,**RN 不认 oklch**
 * (和 `tokens.ts` 顶上说的是同一件事)。所以这里存的是按公式换算后的 sRGB ——
 * oklch→oklab→线性 sRGB→sRGB 全程算出来的,不是肉眼凑的近似值。
 *
 * ★但 `id` 和 `glyph` 是**照抄**的,而 `providerBrand.test.ts` 拿真的 `providerCatalog`
 *  逐个对账:电脑端加一个 provider 而这里没加,那条测试会红 —— 否则表现是手机上那个新代理
 *  的徽章是一个空方框,而没有任何东西会报错。
 *
 * ★`gemini` 的字色在电脑端是 `var(--accent)`(跟着主题走),所以这里存 `null`,
 *  由调用方回落到当前皮肤的 accent —— 抄一个死值进来会让它在换皮肤时不跟着变。
 */

export type ProviderBrand = {
  /** 一个字形。★不是 emoji —— 它要跟着字色走。 */
  glyph: string
  /** 徽章底色(半透明,压在任何背景上都成立)。 */
  bg: string
  /** 字形的颜色。`null` = 用当前皮肤的 accent(电脑端那边写的是 `var(--accent)`)。 */
  fg: string | null
}

export const PROVIDER_BRAND: Record<string, ProviderBrand> = {
  claude: { glyph: '◇', bg: 'rgba(197, 92, 67, 0.18)', fg: '#ec785b' },
  codex: { glyph: '⬡', bg: 'rgba(145, 160, 177, 0.25)', fg: '#aeb9c4' },
  gemini: { glyph: '✦', bg: 'rgba(18, 178, 244, 0.2)', fg: null },
  qoder: { glyph: '◈', bg: 'rgba(145, 77, 230, 0.2)', fg: '#9b61ea' },
  cursor: { glyph: '▸', bg: 'rgba(155, 116, 217, 0.2)', fg: '#b699eb' },
  opencode: { glyph: '◉', bg: 'rgba(148, 130, 116, 0.18)', fg: '#ab9380' },
  qwen: { glyph: '◎', bg: 'rgba(143, 84, 220, 0.2)', fg: '#a473ee' },
  copilot: { glyph: '❉', bg: 'rgba(105, 115, 125, 0.28)', fg: '#b4bfca' },
  pi: { glyph: 'π', bg: 'rgba(0, 173, 113, 0.2)', fg: '#37b880' },
  kimi: { glyph: 'K', bg: 'rgba(222, 57, 75, 0.2)', fg: '#f05560' },
  reasonix: { glyph: '∴', bg: 'rgba(102, 116, 222, 0.2)', fg: '#8393ff' },
  trae: { glyph: 'T', bg: 'rgba(0, 161, 169, 0.2)', fg: '#14bbc2' },
  antigravity: { glyph: 'A', bg: 'rgba(101, 137, 219, 0.2)', fg: '#769cef' },
}

/**
 * 没在表里的(自定义代理)的兜底。
 * ★**不留空**:一个看不见的洞比一个中性的菱形糟糕得多 —— 而且自定义代理是用户自己加的,
 *  他更需要"这一格确实是个代理"这个信号。中性色跟着 `fg: null` 走当前皮肤的 accent。
 */
export const FALLBACK_BRAND: ProviderBrand = { glyph: '◆', bg: 'rgba(128, 138, 152, 0.2)', fg: null }

export const brandFor = (id: string): ProviderBrand => PROVIDER_BRAND[id] ?? FALLBACK_BRAND
