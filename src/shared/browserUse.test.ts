import { describe, it, expect } from 'vitest'
import {
  BROWSER_USE_MODES, DEFAULT_BROWSER_USE, browserUseLabel, isBrowserUseMode,
  browserPermissionConflict, browserToolLabel, browserToolTarget, BROWSER_TOOL_PREFIX,
  providerSupportsBrowserUse, collapseWhitespace,
} from './browserUse'

describe('浏览器开关的档位', () => {
  it('默认是关的 —— 它要连用户已登录的浏览器,是明确的授权行为', () => {
    expect(DEFAULT_BROWSER_USE).toBe('off')
  })
  it('三档齐全且顺序是 关 → 每次询问 → 放行', () => {
    expect(BROWSER_USE_MODES.map(m => m.id)).toEqual(['off', 'ask', 'allow'])
  })
  it('标签有中文,未知值原样回显', () => {
    expect(browserUseLabel('ask')).toContain('询问')
    expect(browserUseLabel('nope' as never)).toBe('nope')
  })
  // ★★这条是防「顺手简化」的:'ask' 和 'allow' 拼出来的 argv 一模一样,弹不弹门只由权限档决定,
  //  所以「放行」这一档的文案**必须**写明它要配合「完全访问」才真的不弹门。谁把它改回
  //  「不再逐个询问,适合长时间自动化」,这条就红 —— 那句话在「自动」档下是假的。
  it('★「放行」档的文案必须挂着「完全访问」这个前提,不许改回「不再逐个询问」', () => {
    const allow = BROWSER_USE_MODES.find(m => m.id === 'allow')!
    expect(`${allow.label} ${allow.desc}`).toContain('完全访问')
    expect(allow.desc).not.toBe('不再逐个询问,适合长时间自动化')
  })
  it('isBrowserUseMode 只认这三个', () => {
    expect(isBrowserUseMode('off')).toBe(true)
    expect(isBrowserUseMode('ask')).toBe(true)
    expect(isBrowserUseMode('allow')).toBe(true)
    expect(isBrowserUseMode('yes')).toBe(false)
    expect(isBrowserUseMode(undefined)).toBe(false)
  })
})

describe('browserPermissionConflict —— 挡住会让授权门失效的组合', () => {
  it('★「完全访问」+「每次询问」:实测这时 bypassPermissions 会吃掉所有门,等于静默放行', () => {
    const msg = browserPermissionConflict('ask', 'full')
    expect(msg).toBeTruthy()
    expect(msg).toContain('完全访问')
  })
  it('「完全访问」+「放行」:用户已经明确表示不要门,放行', () => {
    expect(browserPermissionConflict('allow', 'full')).toBeNull()
  })
  it('浏览器关着时,任何权限档都不冲突', () => {
    expect(browserPermissionConflict('off', 'full')).toBeNull()
    expect(browserPermissionConflict('off', 'auto')).toBeNull()
  })
  // ★「自动」这一半有实测依据(设计 §2.4:acceptEdits 下 navigate 升门,拒绝真的拦住了)。
  // ★「只读」这一半**没有实测过**:§2.4 只量了 acceptEdits 和 bypassPermissions 两档。而且只读档走
  //  `--permission-mode plan`(permissionArgs.ts),按本仓库自己的注释(claude.ts:49-53)plan 会挡掉
  //  **每一个**工具调用 —— 所以「浏览器开 + 只读」大概是个死组合,根本走不到门那一步。
  //  这里断言的只是「conflict 函数不在这两档报冲突」这个事实本身,不声称门在只读档下能拦住。
  //  等装好 Chrome 扩展能实测时再给只读档一个结论;冲突逻辑在那之前不动。
  it('自动档下「每次询问」正常工作 —— 实测门能拦住;只读档不报冲突(该组合未实测,疑似本就跑不起来)', () => {
    expect(browserPermissionConflict('ask', 'auto')).toBeNull()
    expect(browserPermissionConflict('ask', 'readonly')).toBeNull()
  })
})

describe('browserToolLabel —— 把 mcp__claude-in-chrome__* 翻译成人话', () => {
  it('已知工具给出中文标题', () => {
    expect(browserToolLabel(BROWSER_TOOL_PREFIX + 'navigate')).toBe('浏览器 · 打开页面')
    expect(browserToolLabel(BROWSER_TOOL_PREFIX + 'read_console_messages')).toBe('浏览器 · 读控制台')
    expect(browserToolLabel(BROWSER_TOOL_PREFIX + 'computer')).toBe('浏览器 · 截图/点击/输入')
  })
  it('★没见过的工具也要有兜底 —— CLI 以后加新工具时不能把原始长名糊在卡片上', () => {
    expect(browserToolLabel(BROWSER_TOOL_PREFIX + 'brand_new_thing')).toBe('浏览器 · brand_new_thing')
  })
  it('不是浏览器工具就返回 null,让原有逻辑接手', () => {
    expect(browserToolLabel('Bash')).toBeNull()
    expect(browserToolLabel('mcp__forge__forge_delegate')).toBeNull()
  })
})

describe('browserToolTarget / 带目标的标题 —— 「打开页面」要说清是哪个页面', () => {
  it('★有 url 就跟在标题后面:只有「浏览器 · 打开页面」等于把唯一有信息量的那半截丢了', () => {
    expect(browserToolLabel(BROWSER_TOOL_PREFIX + 'navigate', { url: 'https://example.com' }))
      .toBe('浏览器 · 打开页面 example.com')
  })
  it('普通 URL 显示的就是干干净净的 host(协议、结尾斜杠、path 都不要;端口有就留)', () => {
    expect(browserToolTarget({ url: 'https://example.com/' })).toBe('example.com')
    expect(browserToolTarget({ url: 'https://example.com' })).toBe('example.com')
    // ★path 不再跟着:主形态是 new URL().host,门上要判断的是「哪个站点」。端口是站点的一部分,留着。
    expect(browserToolTarget({ url: 'http://localhost:5173/app' })).toBe('localhost:5173')
  })
  it('★带一长串 query 的 URL 退回 host —— 一行卡片塞不下,硬塞会把标题挤掉', () => {
    const long = 'https://shop.example.com/checkout?sku=1234567890&ref=abcdefghijklmnop&utm_source=claude&utm_campaign=x'
    expect(browserToolTarget({ url: long })).toBe('shop.example.com')
    expect(browserToolLabel(BROWSER_TOOL_PREFIX + 'navigate', { url: long })).toBe('浏览器 · 打开页面 shop.example.com')
  })
  it('长且不是合法 URL(相对路径等)就按长度截,不抛', () => {
    const t = browserToolTarget({ url: '/a'.repeat(60) })!
    expect(t.length).toBeLessThanOrEqual(49)
    expect(t.endsWith('…')).toBe(true)
  })
  it('解析不了的短串走退路:剥协议样子的前缀,原样给出', () => {
    expect(browserToolTarget({ url: '/settings/profile' })).toBe('/settings/profile')
    expect(browserToolTarget({ url: 'not a url' })).toBe('not a url')
  })
})

// ★★下面这组是**防伪**,不是排版:授权门是用户决定「让不让 agent 在我已登录的浏览器里动手」的唯一
//  一屏,门上写的站点必须就是请求真正去的站点。每一条都对应一个能让人看着 A 站点按下允许、
//  实际去了 B 站点的具体写法。
describe('browserToolTarget —— 门上写的站点就是真正去的站点', () => {
  const navigate = (url: string) => browserToolLabel(BROWSER_TOOL_PREFIX + 'navigate', { url })!

  it('★超长 host 截**左边**、留右端的可注册域:卡片的 ellipsis 吃的是右边', () => {
    const host = `bank-example-com.${'a'.repeat(160)}.evil.com`
    const t = browserToolTarget({ url: `https://${host}/` })!
    expect(t.length).toBeLessThanOrEqual(48)   // 原来这一支不截,200 字的 host 进标签就是 212 字
    expect(t.startsWith('…')).toBe(true)
    expect(t.endsWith('.evil.com')).toBe(true)
    expect(t).not.toContain('bank-example-com')
    expect(navigate(`https://${host}/`)).toBe(`浏览器 · 打开页面 ${t}`)
  })

  it('★userinfo 不许出现:`bank.example@evil.com` 只显示 evil.com', () => {
    expect(browserToolTarget({ url: 'https://bank.example@evil.com/' })).toBe('evil.com')
    expect(browserToolTarget({ url: 'https://user:pass@evil.com:8443/login' })).toBe('evil.com:8443')
    expect(navigate('https://bank.example@evil.com/')).toBe('浏览器 · 打开页面 evil.com')
  })

  it('★同形字域名显示成 punycode,不显示成和真站点一模一样的字', () => {
    // аррӏе 是西里尔字母,肉眼和 apple 一样。
    expect(browserToolTarget({ url: 'https://аррӏе.com' })).toBe('xn--80ak6aa92e.com')
    expect(browserToolTarget({ url: 'https://аррӏе.com/' })).not.toContain('аррӏе')
  })

  it('★内嵌换行/制表:不能把真正的站点推到折叠线以下,而且显示的是真正去的那个', () => {
    // WHATWG URL 会删掉换行/制表再解析 —— 这串真正去的是 evil.com。
    const spoof = 'https://bank.example\n\n\n\n\n\n@evil.com/x'
    expect(new URL(spoof).host).toBe('evil.com')
    expect(browserToolTarget({ url: spoof })).toBe('evil.com')
    expect(browserToolTarget({ url: 'https://bank.example\t\t@evil.com/x' })).toBe('evil.com')
    // 解析不了的退路也必须是一行:空白一律压成一个空格。
    const t = browserToolTarget({ url: '/a\n\n\n\n/b\t\tc' })!
    expect(t).toBe('/a /b c')
    expect(t).not.toMatch(/[\n\t]/)
  })

  it('collapseWhitespace:任何空白串都压成一个空格,首尾去掉', () => {
    expect(collapseWhitespace('  a\n\n b\t\tc \r\n')).toBe('a b c')
    expect(collapseWhitespace('\n\t ')).toBe('')
  })
  it('没有 url 的工具(read_console_messages / 空输入)标题不变', () => {
    expect(browserToolTarget({})).toBeUndefined()
    expect(browserToolTarget({ url: '   ' })).toBeUndefined()
    expect(browserToolTarget(undefined)).toBeUndefined()
    expect(browserToolLabel(BROWSER_TOOL_PREFIX + 'read_console_messages', {})).toBe('浏览器 · 读控制台')
  })
  it('不传 input(授权门标题那条路:目标由门的 where 另给一栏)也只出标题', () => {
    expect(browserToolLabel(BROWSER_TOOL_PREFIX + 'navigate')).toBe('浏览器 · 打开页面')
  })
})

describe('providerSupportsBrowserUse —— 渲染进程判断要不要显示浏览器开关', () => {
  it('claude 的 CLI 自带浏览器集成', () => {
    expect(providerSupportsBrowserUse('claude')).toBe(true)
  })
  it('codex 没有浏览器集成', () => {
    expect(providerSupportsBrowserUse('codex')).toBe(false)
  })
  it('空字符串不是合法 provider id,自然不支持', () => {
    expect(providerSupportsBrowserUse('')).toBe(false)
  })
})
