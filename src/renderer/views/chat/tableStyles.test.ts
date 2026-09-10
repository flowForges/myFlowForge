import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'chat.css'), 'utf8')

/**
 * ★★用户反馈过两次表格难看:「输出的表格,内容太靠左了」和「html 输出的这个表格,我感觉非常丑」。
 *  两次都改了 —— 但**只改在 `.msg-body` / `.req-title` 上**,而 `.req-plan`(方案卡、运行事件卡)
 *  和 `.md-html`(内嵌 HTML 里的裸表格)各自抄着一份旧样式。于是他在那两处看到的仍然是老样子,
 *  隔了一个版本又来问一次。同一个形状见 [trap-two-call-sites-run-vs-chat]。
 *
 * 这里不测「长什么样」(几何要真 Chrome 量,jsdom 验不了,见 hostsClassNames.test.ts 同一条理由),
 * 只钉死**「四个来源共用同一套规则」**这件事本身 —— 那才是真正会再次漂移的地方。
 */
const SCOPES = ['.msg-body', '.req-title', '.req-plan', '.md-html'] as const

/**
 * 把 CSS 粗切成 `[选择器, 声明块]`。
 * ★**先剥注释**:不剥的话「选择器」里会连着上一条规则之后的整段注释,
 *  于是任何 `^` 锚点都对不上(第一版就栽在这儿)。
 */
function rules(): { sel: string; body: string }[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: { sel: string; body: string }[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(bare))) out.push({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2].trim() })
  return out
}

describe('对话区表格样式:四个来源必须共用一套', () => {
  const all = rules()

  it('★★只有一条 `table` 规则,而且四个来源都在里面', () => {
    const tableRules = all.filter(r => SCOPES.some(sc => r.sel.includes(`${sc} table`)))
    expect(tableRules).toHaveLength(1)
    for (const s of SCOPES) expect(tableRules[0].sel, s).toContain(`${s} table`)
  })

  it('★★单元格的 padding 规则也必须覆盖四个来源 —— 漏一个就是「内容太靠左」重演', () => {
    const cell = all.filter(r => /\bth\b/.test(r.sel) && /\btd\b/.test(r.sel) && /padding:/.test(r.body))
    expect(cell.length).toBeGreaterThan(0)
    const covered = cell.map(r => r.sel).join(' ')
    for (const s of SCOPES) expect(covered, s).toContain(`${s} th`)
  })

  it('★★表格一律不许 `width: 100%` —— 那正是「两列的表被拉满、内容缩在左上角」的根因', () => {
    for (const r of all) {
      if (!/\btable\b/.test(r.sel)) continue
      // ★匹配到声明开头,否则 `max-width:100%` 的子串会把自己判成违规(第一版就这么红了一次)。
      expect(r.body.replace(/\s/g, ''), r.sel).not.toMatch(/(^|;)width:100%/)
    }
  })

  it('表格按内容收(width:auto + max-width:100%)', () => {
    const t = all.find(r => r.sel.includes('.msg-body table'))!
    expect(t.body.replace(/\s/g, '')).toContain('width:auto')
    expect(t.body.replace(/\s/g, '')).toContain('max-width:100%')
  })

  it('★去掉竖线之后列间距是唯一的分列线索,padding 不许再缩回 4px 8px', () => {
    const cell = all.find(r => /\.msg-body th/.test(r.sel) && /padding:/.test(r.body))!
    expect(cell.body).not.toContain('padding: 4px 8px')
  })
})
