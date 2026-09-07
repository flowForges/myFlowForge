import { describe, it, expect } from 'vitest'
import { CHAT_LINE_HEIGHT_DEFAULT } from './chatTypography'
import { AppearanceSchema, defaultSettings } from '../main/config/schema'

/**
 * 行距默认值必须**处处一致**。
 *
 * ★★真正决定所有人看到什么的是主进程 `config/schema.ts`:它解析出来的值会被**写进** settings.json。
 *  只改渲染层的兜底(useSettings / applyTheme)对**任何人**都不生效,连新用户也不生效,而
 *  「改了没反应」这种 bug 查起来最费劲。所以这条测试盯的是主进程那一侧。
 * ★注意生效的那一处是 `z.preprocess` 的兜底,**不是** `.default()` —— 键缺失时 v 是 undefined,
 *  preprocess 先把值补上了,`.default()` 根本到不了(变异验证时确认过:只改 `.default()` 一个数,
 *  这几条断言全绿)。改默认值别只盯着 `.default()`。
 */
/** 一份别的字段都合法、只在 chatLineHeight 上做文章的输入。 */
const withLh = (v?: unknown) => {
  const a: Record<string, unknown> = { ...defaultSettings().appearance }
  if (v === undefined) delete a.chatLineHeight; else a.chatLineHeight = v
  return a
}

describe('会话行距的默认值只有一处真相', () => {
  it('★老配置里没有这个字段时,解析出来就是它(这个值会被写进 settings.json)', () => {
    expect(AppearanceSchema.parse(withLh()).chatLineHeight).toBe(CHAT_LINE_HEIGHT_DEFAULT)
  })
  it('★坏值 / 非数字被纠正回它,而不是纠正回另一个数', () => {
    expect(AppearanceSchema.parse(withLh('x')).chatLineHeight).toBe(CHAT_LINE_HEIGHT_DEFAULT)
  })
  it('★defaultSettings() 同值', () => {
    expect(defaultSettings().appearance.chatLineHeight).toBe(CHAT_LINE_HEIGHT_DEFAULT)
  })
  it('用户自己设过的值不许被覆盖 —— 改默认值不能顺手抹掉人家的选择', () => {
    expect(AppearanceSchema.parse(withLh(1.55)).chatLineHeight).toBe(1.55)
  })
})
