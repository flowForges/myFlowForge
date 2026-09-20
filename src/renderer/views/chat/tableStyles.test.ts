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

  /**
   * ★★★2026-09-17 这条规矩**推翻重写**了。原来钉的是「一律不许 width:100%」,理由是
   *  「两列的表被拉满、内容缩在左上角」。那个观察没错,但结论只对了一半 —— 于是我们在
   *  两个都不对的状态之间来回摆,用户三次说「丑」:
   *    · `width:100%` + 列平分 → 内容缩在一大片空白的左上角(旧的那次)
   *    · `width:auto`        → 表格缩成内容宽,旁边段落却满宽,看着发育不良(「又短又丑」)
   *  ★真正的做法是**两件事一起**:表格满宽,同时让**前面的列按内容收紧、最后一列吃掉剩余**。
   *   这样表格和正文左右对齐,而短列不会被撑成空旷的格子。缺了后半条,width:100% 就又变回老毛病,
   *   所以下面这两条断言**必须成对存在**。
   */
  it('★★按内容收(max-content)—— 拉满宽会让每格空出一大片,内容缩在左上角', () => {
    const t = all.find(r => r.sel.includes('.msg-body table'))!
    expect(t.body.replace(/\s/g, '')).toContain('width:max-content')
    expect(t.body.replace(/\s/g, '')).toContain('max-width:100%')
  })

  it('★★★而且必须有**轮廓** —— 没有它,按内容收的表就是几行浮着的字,那才是「又短又丑」的来源', () => {
    // 这两条**必须成对存在**:只收窄不给轮廓 = 第二次那版;只给轮廓不收窄 = 第一次那版。
    // 病根从来不在宽度,在「表格没有边界」。
    const t = all.find(r => r.sel.includes('.msg-body table'))!
    const b = t.body.replace(/\s/g, '')
    expect(b, '缺少外框').toContain('border:1pxsolid')
    expect(b, '缺少圆角').toContain('border-radius:')
    // 圆角要裁得住必须是 separate;collapse 下圆角不生效。
    expect(b).toContain('border-collapse:separate')
  })

  it('★有了轮廓,首末列就不能再贴边 —— 第一个字会压在边框上', () => {
    const edge = all.find(r => /td:first-child/.test(r.sel) && /padding-left/.test(r.body))
    expect(edge, '还留着「首列 padding-left: 0」那条').toBeFalsy()
  })

  it('★去掉竖线之后列间距是唯一的分列线索,padding 不许再缩回 4px 8px', () => {
    const cell = all.find(r => /\.msg-body th/.test(r.sel) && /padding:/.test(r.body))!
    expect(cell.body).not.toContain('padding: 4px 8px')
  })
})
