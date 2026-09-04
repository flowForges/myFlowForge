import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const css = (p: string) => readFileSync(join(here, p), 'utf8')

/**
 * 底部状态栏「左边让、右边不让」这条约束的守卫。
 *
 * ★★2026-09-04 实测的事故现场(13 个 provider 全装 + 900px 窗口,真 Chrome 量的):
 *  右边那组从 x=1191 起画 —— 窗口右边界外 291px,整组 554px 在屏幕外,
 *  终端 / 实时日志 / 版本号 / 主机按钮**一个都点不到**;状态栏还从 30px 撑到了 67px,
 *  因为「Claude Code」「Cursor Agent」这些带空格的名字被挤成了两行。
 *  两个症状同一个根因:flex item 默认 `min-width: auto`,左边那组拒绝收缩到内容宽度以下,
 *  于是把右边整个推出窗口。修完同一组测量:五种组合(2/5/13 个 provider × 1400/1200/900/700 窗口)
 *  栏高恒定,右组右边界永远落在窗口内,装不下时左组横向滚动。
 *
 * ★这里**不测像素**(那要真 Chrome 量 computed style,jsdom 验不了 —— 和 hostsClassNames
 *  那份守卫同一条理由)。这里只钉死那几条「一删就复发」的声明。
 * ★★注释必须先剥掉:上面那段解释里就写着 `min-width: 0`,不剥的话这份守卫第一次跑就被
 *  自己的注释喂饱、直接变绿。hostsClassNames.test.ts 正是这么栽过一次。
 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ')

/**
 * 取出某条选择器的**全部**声明块(已剥注释),拼在一起。
 * ★不能只取第一处:`.statusbar` 就有两条(基础的 + 毛砂皮肤下换背景那条,选择器是
 *  `.window.glass .statusbar`,`indexOf` 会先撞上它),只看第一处会拿到不相干的那块。
 */
function ruleOf(source: string, selector: string): string {
  const src = strip(source)
  const blocks: string[] = []
  for (let i = src.indexOf(selector + ' {'); i >= 0; i = src.indexOf(selector + ' {', i + 1)) {
    blocks.push(src.slice(i, src.indexOf('}', i)))
  }
  expect(blocks.length, `CSS 里找不到 ${selector} —— 规则被改名或删了`).toBeGreaterThan(0)
  return blocks.join('\n')
}

describe('★状态栏:装再多编码 CLI 也不许把右边的控件顶出屏幕', () => {
  const shell = css('shell.css')
  const global = css('../theme/global.css')

  it('左边那组能缩到 0 —— min-width:0 是整件事的关键', () => {
    const r = ruleOf(shell, '.sb-models')
    expect(r).toMatch(/min-width:\s*0/)
    expect(r).toMatch(/flex:\s*1 1 auto/)
  })

  it('左边装不下时横向滚动,而不是把右边推出去', () => {
    const r = ruleOf(shell, '.sb-models')
    expect(r).toMatch(/overflow-x:\s*auto/)
    // ★y 必须显式 hidden:只写 overflow-x:auto 的话 y 会跟着变成 auto,
    //   30px 高的栏里会冒出一根竖滚动条。
    expect(r).toMatch(/overflow-y:\s*hidden/)
  })

  it('★单个 pill 不许折行 —— 折了就把 30px 的栏撑高(实测 67px)', () => {
    const r = ruleOf(shell, '.sb-model')
    expect(r).toMatch(/white-space:\s*nowrap/)
    expect(r).toMatch(/flex:\s*0 0 auto/)
  })

  it('★★右边那组不参与收缩:它全是控件,挤扁了就点不到', () => {
    const r = ruleOf(shell, '.sb-right')
    expect(r).toMatch(/flex:\s*0 0 auto/)
    // ★不能再有 auto 外边距:它会**先于** flex-grow 吃掉剩余空间,
    //   于是 .sb-models 永远长不起来,右端那层淡出蒙版会盖在最后一个 pill 上。
    expect(r).not.toMatch(/margin-left:\s*auto/)
  })

  it('状态栏自己兜底 overflow:hidden —— 里面装什么都不许溢出到窗口外', () => {
    expect(ruleOf(global, '.statusbar')).toMatch(/overflow:\s*hidden/)
  })
})

describe('★主机按钮用的 class 在 CSS 里真的存在', () => {
  /**
   * 这个仓库栽过:CSS 里不存在的 class 不报错、只静默退回默认样式 ——
   * typecheck 全绿、测试全绿,用户一眼就看出不对(见 hostsClassNames.test.ts)。
   * 主机按钮 2026-09-04 从标题栏搬到状态栏,换了一整套 class,正是最容易漏的时候。
   */
  const all = strip(css('shell.css') + '\n' + css('logcon.css') + '\n' + css('../theme/global.css'))
  const used = ['host-switch', 'sb-host', 'lg-dot', 'sb-log', 'hs-pop', 'hs-item', 'hs-sep', 'hs-err']

  it.each(used)('.%s 有对应的规则', (c) => {
    expect(new RegExp(`\\.${c}[\\s.,:{>+~[]`).test(all)).toBe(true)
  })

  it('★状态色四档一条不少(绿/黄/红/灰) —— 少一档就是某个状态没颜色', () => {
    for (const tone of ['ok', 'warn', 'bad', 'idle']) {
      expect(all, `.sb-host.${tone} 没有规则`).toMatch(new RegExp(`\\.sb-host\\.${tone}`))
    }
  })
})
