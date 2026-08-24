import type { ToolActivity } from '../../../src/shared/types'

/**
 * 工具卡的**纯逻辑**:把服务端已有的 `ToolActivity`(id/title/name/output/status)翻译成
 * 原型 `d.css` 里 `.tool .th` 那一行需要的三段 —— 动词 `.k` / 目标 `.p` / 右侧统计 `.s` ——
 * 以及展开后 `.code` 里的行。
 *
 * ★**一个字段都不新发明**。手机端拿到的就是桌面端 `执行` 块拿到的那份;这里做的全部是显示层的
 *  解析。服务端没给的东西(比如 codex 的 `编辑文件` 根本不带 output)就**如实地什么都不显示**,
 *  绝不猜一个 diff 出来 —— 手机上「看起来它改了这些」比「不知道它改了什么」危险得多。
 *
 * 真实的 title 形状(从本机各工作区 `.forge/sessions` 下 762 条落档数据归纳):
 *   claude/qoder/agy → `调用 Read <路径>` / `调用 Bash: <命令>` / `调用 Bash`(输入里没有 command 时)
 *   codex           → `调用 shell: /bin/zsh -lc '<命令>'` / `编辑文件: <绝对路径>` / `调用 shell…`
 *   cursor          → 自由文本
 */

/** 折叠态一行要显示的三段。`stat` 为空就不画那一格。 */
export type ToolHead = {
  /** `.k` —— 动词。读取 / 编辑 / 写入 / 执行 / 搜索 / 抓取 / 子代理 / 调用 */
  verb: string
  /** `.p` —— 目标(路径或命令)。可能是空串:provider 只报了工具名。 */
  target: string
  /** `.s` —— 右侧统计。`+12 −4` 或 `1–240` 或 ''。 */
  stat: string
  /** 编辑/写入类的加减行数,给 `.a`/`.r` 分别着色用。 */
  add?: number
  del?: number
}

const VERB_BY_NAME: Record<string, string> = {
  read: '读取',
  notebookread: '读取',
  edit: '编辑',
  multiedit: '编辑',
  notebookedit: '编辑',
  write: '写入',
  bash: '执行',
  shell: '执行',
  bashoutput: '执行',
  run_command: '执行',
  run_terminal_cmd: '执行',
  grep: '搜索',
  glob: '搜索',
  search: '搜索',
  codebase_search: '搜索',
  read_file: '读取',
  write_file: '写入',
  edit_file: '编辑',
  webfetch: '抓取',
  websearch: '搜索',
  task: '子代理',
  agent: '子代理',
}

/**
 * 从 `调用 <Name>` / `调用 <Name>: <arg>` / `调用 <Name> <arg>` / `编辑文件: <path>` 里
 * 把工具名和参数拆出来。拆不动就原样当目标。
 */
function splitTitle(title: string): { name: string; arg: string } {
  const t = title.trim()
  // codex 的补丁行:`编辑文件: a.ts, b.ts` / `编辑文件…`
  if (t.startsWith('编辑文件')) return { name: 'edit', arg: t.replace(/^编辑文件[::]?\s*/, '').replace(/…$/, '') }
  // ★工具名按**标识符**卡死,不能写成 `\S+`:`调用 Bash: npm run build` 里 `\S+` 会把冒号一起吃掉,
  //  而懒惰的 `\S+?` 只会匹配到第一个字母(`调用 ExitPlanMode` 拆出来是 `E` + `xitPlanMode`)。
  const m = /^调用\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:[::]\s*)?([\s\S]*)$/.exec(t)
  if (m) return { name: m[1], arg: m[2].trim().replace(/^…$/, '') }
  return { name: '', arg: t }
}

/**
 * `/bin/zsh -lc 'git status --short'` → `git status --short`。
 * codex 每条命令都套一层登录 shell,不剥掉的话 390px 宽的一行里前 14 个字符全是噪音,
 * 真正的命令被省略号吃掉。
 */
export function stripShellWrapper(cmd: string): string {
  const m = /^\S*(?:sh|bash|zsh)\s+-[a-z]*c\s+([\s\S]+)$/.exec(cmd.trim())
  if (!m) return cmd.trim()
  const body = m[1].trim()
  const q = body[0]
  if ((q === '"' || q === "'") && body.endsWith(q) && body.length >= 2) return body.slice(1, -1)
  return body
}

/** `1\t文本` / `   479→文本` 这两种带行号的输出各自的行号。都不是就返回 null。 */
function numberedLine(line: string): { ln: number; text: string } | null {
  const m = /^\s*(\d+)(?:\t|→)([\s\S]*)$/.exec(line)
  if (!m) return null
  return { ln: Number(m[1]), text: m[2] }
}

export type CodeLine = { ln: string; text: string; kind: 'ctx' | 'add' | 'del' }

/** 展开后 `.code` 里的内容。`total` 是原始行数,`lines` 可能被截断过。 */
export type ToolBody = {
  lines: CodeLine[]
  total: number
  /** 被截断了多少行。>0 时界面**必须如实说**,不能静默吞掉。 */
  dropped: number
  /** 统一 diff / 带行号的读取 / 纯文本 —— 只影响背景色和行号列画不画。 */
  kind: 'diff' | 'numbered' | 'plain'
}

/** 一屏手机放不下几千行日志,而且 RN 的每一行都是一个真实 View。超过就截断并说出来。 */
export const BODY_LINE_CAP = 200

/**
 * 把工具输出切成可渲染的行。
 *
 * 三种形状,按可靠度从高到低认:
 *  ① 统一 diff —— 有 `@@ … @@` 段头。只有这一种才敢按 +/− 着色:
 *     普通命令输出里以 `-` 开头的行满地都是(`ls -l`、markdown 列表),按前缀猜会把它们全染红。
 *  ② 带行号 —— `1\t…`(claude Read)或 `   479→…`(claude Edit 回显的 cat -n 片段)。
 *  ③ 其它 —— 纯文本,不着色不画行号。
 */
export function parseToolBody(output: string, cap = BODY_LINE_CAP): ToolBody {
  const raw = output.replace(/\n+$/, '').split('\n')
  const total = raw.length
  const kept = raw.slice(0, cap)
  const dropped = total - kept.length

  const isDiff = raw.some((l) => /^@@ .* @@/.test(l))
  if (isDiff) {
    return {
      kind: 'diff',
      total,
      dropped,
      lines: kept.map((l) => ({
        ln: '',
        text: l,
        kind: l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : 'ctx',
      })),
    }
  }

  const nums = kept.map(numberedLine)
  // 半数以上的行带行号才算「带行号的输出」—— claude 的 Edit 回显前面有一句散文说明,
  // 只看第一行会判错。
  if (nums.filter(Boolean).length > kept.length / 2) {
    return {
      kind: 'numbered',
      total,
      dropped,
      lines: kept.map((l, i) => {
        const n = nums[i]
        return n ? { ln: String(n.ln), text: n.text, kind: 'ctx' as const } : { ln: '', text: l, kind: 'ctx' as const }
      }),
    }
  }

  return { kind: 'plain', total, dropped, lines: kept.map((l) => ({ ln: '', text: l, kind: 'ctx' as const })) }
}

/** 带行号的输出 → `479–513`(原型里读取卡右边显示的就是行号区间)。 */
function lineRange(body: ToolBody): string {
  if (body.kind !== 'numbered') return ''
  const ns = body.lines.map((l) => Number(l.ln)).filter((n) => Number.isFinite(n) && n > 0)
  if (!ns.length) return ''
  const lo = Math.min(...ns)
  const hi = Math.max(...ns)
  return lo === hi ? String(lo) : `${lo}–${hi}`
}

/** 统一 diff → 加减行数。 */
function diffCounts(body: ToolBody): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const l of body.lines) {
    if (l.kind === 'add') add++
    else if (l.kind === 'del') del++
  }
  return { add, del }
}

/** 折叠态那一行。`body` 传进来是为了让统计和展开的内容出自同一次解析。 */
export function toolHead(tool: ToolActivity, body: ToolBody | null): ToolHead {
  const { name, arg } = splitTitle(tool.title ?? '')
  const key = (tool.name ?? name ?? '').toLowerCase()
  const verb = VERB_BY_NAME[key] ?? '调用'
  const shown = verb === '执行' ? stripShellWrapper(arg) : arg
  // provider 只报了工具名(实测 `调用 Bash` 这一种真的会出现)时,目标位退成工具名本身,别留空格。
  const target = shown || tool.name || name

  if (body) {
    if (body.kind === 'diff') {
      const { add, del } = diffCounts(body)
      if (add || del) return { verb, target, stat: `+${add} −${del}`, add, del }
    }
    const r = lineRange(body)
    if (r) return { verb, target, stat: r }
  }
  return { verb, target, stat: '' }
}

/** 状态标记。运行中不画(那一格留给运行条),完成打勾,失败打叉。 */
export function statusMark(s: ToolActivity['status']): string {
  return s === 'run' ? '' : s === 'error' ? '✗' : '✓'
}
