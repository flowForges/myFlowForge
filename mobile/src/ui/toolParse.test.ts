import { describe, it, expect } from 'vitest'
import type { ToolActivity } from '../../../src/shared/types'
import type { ToolBody } from './toolParse'
import { BODY_LINE_CAP, parseToolBody, stripShellWrapper, toolHead, statusMark } from './toolParse'

/**
 * 这些用例的**输入全部抄自真数据** —— 本机各工作区 `.forge/sessions` 下落档的
 * 762 条 ToolActivity。不是我想象中 provider 会长什么样。
 */

const t = (o: Partial<ToolActivity>): ToolActivity => ({ id: 'x', title: '', status: 'ok', ...o })

describe('toolHead —— 折叠态那一行', () => {
  it('claude 的 Read:动词按 name,目标是路径', () => {
    const h = toolHead(t({ name: 'Read', title: '调用 Read src/main/ipc/handlers.ts' }), null)
    expect(h.verb).toBe('读取')
    expect(h.target).toBe('src/main/ipc/handlers.ts')
  })

  it('claude 的 Bash:动词是执行,目标是命令', () => {
    const h = toolHead(t({ name: 'Bash', title: '调用 Bash: npm run build' }), null)
    expect(h.verb).toBe('执行')
    expect(h.target).toBe('npm run build')
  })

  it('★codex 没有 name,只能从 title 里认出工具名', () => {
    // 实测:762 条里 733 条的 name 是 undefined(codexToolActivity 根本不填)。
    // 只看 tool.name 的话,codex 的每一张卡都会显示成「调用」。
    const h = toolHead(t({ title: "调用 shell: /bin/zsh -lc 'git status --short'" }), null)
    expect(h.verb).toBe('执行')
    expect(h.target).toBe('git status --short')
  })

  it('★codex 的 `编辑文件: <绝对路径>`', () => {
    const h = toolHead(t({ title: '编辑文件: /Users/zghua/work/workspace/ff-website/website/index.html' }), null)
    expect(h.verb).toBe('编辑')
    expect(h.target).toBe('/Users/zghua/work/workspace/ff-website/website/index.html')
  })

  it('`调用 Bash` 光杆(输入里没有 command)也不能崩,目标退成工具名', () => {
    const h = toolHead(t({ name: 'Bash', title: '调用 Bash' }), null)
    expect(h.verb).toBe('执行')
    expect(h.target).toBe('Bash')
  })

  it('不认识的工具名保持「调用 + 原文」,不瞎猜动词', () => {
    const h = toolHead(t({ name: 'ExitPlanMode', title: '调用 ExitPlanMode' }), null)
    expect(h.verb).toBe('调用')
    expect(h.target).toBe('ExitPlanMode')
  })

  it('cursor 的自由文本 title:整句当目标', () => {
    const h = toolHead(t({ title: 'Reading lints in 3 files' }), null)
    expect(h.target).toBe('Reading lints in 3 files')
  })

  it('带行号的输出 → 右侧显示行号区间(原型 `479–513` 那一格)', () => {
    const body = parseToolBody('479\tconst a = 1\n480\tconst b = 2\n513\treturn a + b')
    const h = toolHead(t({ name: 'Read', title: '调用 Read a.ts' }), body)
    expect(h.stat).toBe('479–513')
  })

  it('统一 diff → 右侧显示 +N −M,并分别给出数字好上色', () => {
    const body = parseToolBody(['@@ -1,3 +1,4 @@', ' ctx', '-old', '+new1', '+new2'].join('\n'))
    const h = toolHead(t({ name: 'Edit', title: '调用 Edit a.ts' }), body)
    expect(h.stat).toBe('+2 −1')
    expect(h.add).toBe(2)
    expect(h.del).toBe(1)
  })

  it('★行号区间只认「带行号」那一种输出', () => {
    // 白盒:直接递一份 kind 是 plain、行里却带着数字的 body 进去。
    // 少了 kind 这道门,`ls -l` 的输出也会在卡片右边显示成一个「行号区间」。
    const faked: ToolBody = {
      kind: 'plain',
      total: 2,
      dropped: 0,
      lines: [
        { ln: '479', text: 'a', kind: 'ctx' },
        { ln: '513', text: 'b', kind: 'ctx' },
      ],
    }
    expect(toolHead(t({ title: '调用 shell: ls -la' }), faked).stat).toBe('')
    expect(toolHead(t({ name: 'Read', title: '调用 Read a.ts' }), { ...faked, kind: 'numbered' }).stat).toBe('479–513')
  })

  it('★★散文 + 行号混着时,区间只算真有行号的那些', () => {
    // 这正是 claude 的 Edit 回显:第一行是一句说明(没有行号),后面才是 cat -n 片段。
    // 没行号那行的 ln 是空串,而 `Number('')` 是 **0** —— 守卫少写一个 `> 0`,
    // 区间就会显示成 `0–481`,凭空多出一个不存在的第 0 行。
    const body = parseToolBody(["The file a.ts has been updated. Here's the result:", '479\ta', '480\tb', '481\tc'].join('\n'))
    expect(body.kind).toBe('numbered')
    expect(toolHead(t({ name: 'Edit', title: '调用 Edit a.ts' }), body).stat).toBe('479–481')
  })

  it('★恰好一半的行带行号时,不算「带行号的输出」', () => {
    // 判据是「**超过**一半」。改成「达到一半」的话,一条输出里随便夹两个数字开头的行
    // 就会被当成 cat -n 片段,于是正文被当行号切掉。
    const half = parseToolBody('1\ta\n2\tb\nplain one\nplain two')
    expect(half.kind).toBe('plain')
    const more = parseToolBody('1\ta\n2\tb\n3\tc\nplain one')
    expect(more.kind).toBe('numbered')
  })

  it('★纯文本输出不假装有统计', () => {
    // codex 的 `编辑文件` 根本不带 output;shell 的输出是自由文本。
    // 这里编一个 `+12 −4` 出来,人在手机上就会以为自己看到了改动量。
    const body = parseToolBody('total 0\ndrwxr-xr-x 7 zghua staff 224 .')
    expect(toolHead(t({ title: '调用 shell: ls -la' }), body).stat).toBe('')
    expect(toolHead(t({ title: '编辑文件: a.ts' }), null).stat).toBe('')
  })
})

describe('stripShellWrapper —— 剥掉 codex 的登录 shell', () => {
  it("单引号", () => {
    expect(stripShellWrapper("/bin/zsh -lc 'git status --short'")).toBe('git status --short')
  })
  it('双引号', () => {
    expect(stripShellWrapper('/bin/bash -lc "sed -n \'1,220p\' a.go"')).toBe("sed -n '1,220p' a.go")
  })
  it('没套壳就原样返回', () => {
    expect(stripShellWrapper('npm run build')).toBe('npm run build')
  })
  it('★只有一对空引号 / 单个引号时不能切出空命令', () => {
    // `body.length >= 2` 那个守卫管的就是这里:少了它,`'` 这种残缺输入会被 slice 成空串,
    // 卡片上的命令那一栏直接变空 —— 而人正是靠它判断代理要跑什么。
    expect(stripShellWrapper(`/bin/zsh -lc ''`)).toBe('')
    expect(stripShellWrapper(`/bin/zsh -lc '`)).toBe("'")
    expect(stripShellWrapper(`/bin/zsh -lc "`)).toBe('"')
  })

  it('★不能把 `-c` 之后的内容切断:命令里自己带引号也要留住', () => {
    expect(stripShellWrapper(`/bin/zsh -lc 'echo "a b" && ls'`)).toBe('echo "a b" && ls')
  })
})

describe('parseToolBody —— 展开后的行', () => {
  it('claude Read 的 `1\\t文本` 拆成行号 + 正文', () => {
    const b = parseToolBody('1\t# 标题\n2\t\n3\t正文')
    expect(b.kind).toBe('numbered')
    expect(b.lines[0]).toEqual({ ln: '1', text: '# 标题', kind: 'ctx' })
    expect(b.lines[2]).toEqual({ ln: '3', text: '正文', kind: 'ctx' })
  })

  it('claude Edit 回显的 `   479→文本` 也认', () => {
    const b = parseToolBody('   479→const a = 1\n   480→const b = 2')
    expect(b.kind).toBe('numbered')
    expect(b.lines[0].ln).toBe('479')
    expect(b.lines[0].text).toBe('const a = 1')
  })

  it('统一 diff 按 +/− 上色', () => {
    const b = parseToolBody(['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-old', '+new'].join('\n'))
    expect(b.kind).toBe('diff')
    expect(b.lines.map((l) => l.kind)).toEqual(['ctx', 'ctx', 'ctx', 'del', 'add'])
  })

  it('★没有 @@ 段头就绝不按 +/− 上色', () => {
    // `ls -l`、markdown 列表、diff --stat 的输出里以 `-` 开头的行满地都是。
    // 按前缀猜的话,一条普通命令的输出会被染成一片红。
    const b = parseToolBody('- 第一条\n- 第二条\n+ 号也可能是正文')
    expect(b.kind).toBe('plain')
    expect(b.lines.every((l) => l.kind === 'ctx')).toBe(true)
  })

  it('★散文开头 + 大段行号(claude Edit 的真实回显)仍判成带行号', () => {
    const out = ['The file a.ts has been updated. Here\'s the result:', '   1→a', '   2→b', '   3→c'].join('\n')
    const b = parseToolBody(out)
    expect(b.kind).toBe('numbered')
    // 那句散文没有行号,原样留着,不能吞掉
    expect(b.lines[0].text).toContain('has been updated')
    expect(b.lines[0].ln).toBe('')
  })

  it('★超长输出截断,而且把丢掉多少行说出来', () => {
    const out = Array.from({ length: BODY_LINE_CAP + 37 }, (_, i) => `line ${i}`).join('\n')
    const b = parseToolBody(out)
    expect(b.lines.length).toBe(BODY_LINE_CAP)
    expect(b.total).toBe(BODY_LINE_CAP + 37)
    expect(b.dropped).toBe(37)
  })

  it('末尾的空行不算一行', () => {
    expect(parseToolBody('a\nb\n\n\n').total).toBe(2)
  })
})

describe('statusMark', () => {
  it('运行中不画标记 —— 那一格留给运行条', () => {
    expect(statusMark('run')).toBe('')
    expect(statusMark('ok')).toBe('✓')
    expect(statusMark('error')).toBe('✗')
  })
})
