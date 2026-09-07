import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Markdown } from './markdown'

/**
 * `_` 什么时候算斜体标记。
 *
 * ★★这是 2026-09-07 用户在真机截图里拍到的 bug,而且**一个根因串起两个症状**:
 *  规则表里 `_([^_]+)_` 没有词边界守卫,于是 `APPLY_PASS` 的下划线就是一个合法的开标记。
 *  由于 renderInline 挑的是「m.index 最小者」,它比后面的反引号先命中,一口吞到下一个下划线:
 *
 *    对应 APPLY_PASS 流程中的 `GAODE_SUPER_RELATION` 节点…
 *      → 文本"对应 APPLY" + 斜体"PASS 流程中的 `GAODE" + 文本"SUPER" + 斜体"RELATION` 节点…"
 *
 *  ① 标识符里的下划线被当成标记**吃掉**(APPLYPASS / GAODESUPERRELATION);
 *  ② 斜体跨过了开反引号,代码 span 的配对被打断 → 反引号**原样漏成字面量**
 *     (用户原话:「有些 markdown 还没解析成功,比如 `` 这个」);
 *  ③ 同理会把 `[文字](路径)` 拆散 —— 路径里有下划线是常态。
 *
 * CommonMark 早就规定了:`*` 可以在词中强调,**`_` 不可以**,理由正是标识符。这里按它来:
 * 开/闭标记的外侧不能紧挨着字母或数字(`\p{L}\p{N}`,所以中文也算 —— 见「中文紧挨」那条)。
 */
const html = (t: string) => render(<Markdown text={t} />).container.innerHTML

describe('下划线不在词中作斜体', () => {
  it('★★截图里那一句:标识符原样保留,反引号正常成代码,一个 <em> 都不该有', () => {
    const out = html('对应 APPLY_PASS 流程中的 `GAODE_SUPER_RELATION` 节点最终成功，但 `retry_cnt=2044`。')
    expect(out).not.toContain('<em>')
    expect(out).toContain('APPLY_PASS')
    expect(out).toContain('<code>GAODE_SUPER_RELATION</code>')
    expect(out).toContain('<code>retry_cnt=2044</code>')
    expect(out, '反引号漏成了字面量').not.toContain('`')
  })

  it('★同一条 bullet 里的链接不能被拆散(路径里有下划线是常态)', () => {
    const out = html('没有"迟到订单补建 ACTIVITY_END 任务"的逻辑：[tool_worker_activity_end.go](/a/tool_worker_activity_end.go)')
    expect(out).not.toContain('<em>')
    expect(out).toContain('>tool_worker_activity_end.go</a>')
    expect(out).toContain('ACTIVITY_END')
  })

  it('单个标识符原样输出', () => {
    for (const s of ['apply_status=EFFECTIVE', 'total_order_count=59', 'a_b_c_d', 'MAX_RETRY_COUNT']) {
      expect(html(s), s).toContain(s)
    }
  })

  it('★已知且**故意**不管的一例:光秃秃的 `__init__` 仍然是粗体的 init', () => {
    // CommonMark 就是这么定的(开标记在行首、闭标记后是行尾,两侧都成立),市面上每个渲染器都一样。
    // 为它破例得让「`__` 在行首不许开标记」,那会顺手弄坏 `__很重要__` 这种正常写法。
    // Python 的 dunder 写在正文里请用反引号 —— 那条路是好的(见下面这半条断言)。
    expect(html('__init__')).toContain('<strong>init</strong>')
    expect(html('`__init__`')).toContain('<code>__init__</code>')
  })

  it('★真正的斜体还要能用 —— 两侧是空白/标点时照常', () => {
    expect(html('这是 _斜体_ 文字')).toContain('<em>斜体</em>')
    expect(html('_整行都是斜体_')).toContain('<em>整行都是斜体</em>')
    expect(html('（_括号里_）')).toContain('<em>括号里</em>')
  })

  it('★中文紧挨着不算(CommonMark:外侧是字母就不开标记,中文也是字母)', () => {
    expect(html('参数_x_的值')).not.toContain('<em>')
  })

  it('__粗体__ 不能被降级成斜体', () => {
    expect(html('__很重要__')).toContain('<strong>很重要</strong>')
  })

  it('★空的两侧不算:`_ 前后有空格 _` 不是斜体(CommonMark)', () => {
    expect(html('a _ 不是斜体 _ b')).not.toContain('<em>')
  })

  it('★星号在词中仍然算斜体 —— CommonMark 对 * 和 _ 的规矩本来就不一样,别顺手改坏', () => {
    expect(html('foo*bar*baz')).toContain('<em>bar</em>')
  })
})
