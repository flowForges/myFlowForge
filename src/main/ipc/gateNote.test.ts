import { describe, it, expect } from 'vitest'
import { gateNoteBody } from './gateNote'

/**
 * 这份测试守的是一句话:**审计消息不许改写被审计的那条命令。**
 * 2026-09-04 用户截图里,`recruit_apply_order.go` 被渲染成 `recruit` + 斜体 `apply` + `order.go` ——
 * 一条为了「留痕」而存在的消息,把留下来的痕迹改成了一个不存在的文件名。
 */

/** 渲染器的行内规则(照抄 `views/chat/markdown.tsx` 的那几条),用来判断一段文字会不会被当成标记吃掉。 */
const INLINE = [/`([^`]+)`/, /\*\*([^*]+)\*\*/, /__([^_]+)__/, /\*([^*]+)\*/, /_([^_]+)_/, /\[([^\]]+)\]\(([^)\s]+)\)/]

/** 把消息按围栏切开,返回**围栏外**的正文 —— 只有这部分会被解析成 markdown。 */
function outsideFences(body: string): string {
  const lines = body.split('\n')
  const out: string[] = []
  let fence = ''
  for (const l of lines) {
    const m = /^(`{3,})/.exec(l)
    if (fence) { if (m && m[1].length >= fence.length) fence = ''; continue }
    if (m) { fence = m[1]; continue }
    out.push(l)
  }
  return out.join('\n')
}

describe('权限门审计消息', () => {
  it('没有 where 时就是标题一行,不平白多出一个空代码块', () => {
    expect(gateNoteBody({ title: 'Bash 请求执行' })).toBe('Bash 请求执行')
    expect(gateNoteBody({ title: 'Bash 请求执行', where: '   ' })).toBe('Bash 请求执行')
  })

  it('★★用户截图里那条:下划线不许被吃成斜体', () => {
    const where = 'grep -n "func (o \\*RecruitApplyOrder) CloneAsRejected" -A 75 internal/merchant-recruitment/domain/entity/recruit_apply_order.go'
    const body = gateNoteBody({ title: 'Bash 请求执行', where })
    // 命令原样出现在消息里
    expect(body).toContain(where)
    // 而且**在围栏里** —— 围栏外没有任何一条行内规则能命中
    const outside = outsideFences(body)
    expect(outside.trim()).toBe('Bash 请求执行')
    for (const re of INLINE) expect(re.test(outside), `围栏外被 ${re} 命中了`).toBe(false)
  })

  it('★星号/反引号/链接语法一样不许被解释', () => {
    const where = 'ls *.go && echo `date` && sed -i "s/[a]/(b)/"'
    const outside = outsideFences(gateNoteBody({ title: 'Bash 请求执行', where }))
    for (const re of INLINE) expect(re.test(outside)).toBe(false)
  })

  it('★★命令自己带 ``` 时,围栏要加长 —— 否则内容会把围栏从中间劈开', () => {
    const where = "cat <<'EOF'\n```\nhello\n```\nEOF"
    const body = gateNoteBody({ title: 'Bash 请求执行', where })
    const fence = /^(`{3,})$/m.exec(body)![1]
    expect(fence.length).toBeGreaterThan(3)
    // 切出来的围栏外仍然只有标题:命令一行都没漏出去
    expect(outsideFences(body).trim()).toBe('Bash 请求执行')
  })

  it('★多行命令的换行保住 —— 原来是拼成一行长文,三条就糊满一屏', () => {
    const where = 'cd /tmp\necho 一\necho 二'
    const body = gateNoteBody({ title: 'Bash 请求执行', where })
    expect(body).toContain('cd /tmp\necho 一\necho 二')
    expect(body.split('\n').length).toBeGreaterThan(4)
  })

  it('文件路径这类短 where 也照样进围栏 —— 路径里的下划线同样会被吃掉', () => {
    const outside = outsideFences(gateNoteBody({ title: '写入文件', where: 'src/a_b_c.ts' }))
    expect(outside.trim()).toBe('写入文件')
  })
})
