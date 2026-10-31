// allow_session 的键(spec §10 + 控制者裁定):内核审批与 tools-registry 共用,纯函数

/**
 * 字符允许清单(控制者裁定):整条命令只许这些字符,词之间只许空格与制表符。
 * 其余字符(`; & | \` $ > <`、引号、反斜杠、`? [ ] { } ~ ! # ^`、换行与其他空白)都可能被 shell
 * 在程序看到之前改写(去引号、花括号 / 波浪号 / 变量展开、通配),参数检查就不再可靠 → 一律无键
 */
const SAFE_COMMAND = /^[ \tA-Za-z0-9_@%+=:,./*-]*$/
/** 点开头的路径段带 `*`(`.*`、`--x=.*`、`-w.*`):bash 3.2 的通配会匹配 `.` 与 `..` */
const DOT_GLOB = /(^|[/=:,]|^-[A-Za-z]+)\.[^/]*\*/
/** win32 的 cmd 会展开成对的 `%VAR%`(延迟展开的 `!` 已不在字符清单里) */
const CMD_VAR = /%[^%]*%/
/** 第一个词只许朴素拼写:引号、反斜杠、括号、通配符、~、= 都会让名单比较失效 */
const PLAIN_WORD = /^[\w./+-]+$/

/** 允许清单(控制者裁定):只有这些命令能拿到键;其余每次都问 */
/**
 * (a) 键 = 第一个词;第二个词可以是 `-` 开头的选项。
 * 不收能读任意文件的命令(cat、grep 等):shell 不经路径权限门,放行一次等于放行读 ~/.ssh
 */
const BY_NAME = new Set([
  'ls', 'pwd', 'echo', 'which',
  'make', 'tsc', 'eslint', 'prettier', 'vitest', 'jest', 'pytest', 'mypy', 'ruff',
])
/** (b) 命令 + 子命令:键 = 两个词;子命令不在清单里 → 没有键 */
const JS_PM = ['test', 'run', 'install', 'ci', 'build', 'lint', 'typecheck']
const BY_PAIR = new Map<string, Set<string>>([
  ['git', new Set(['status', 'diff', 'log', 'show', 'branch', 'add', 'commit', 'checkout', 'switch', 'stash', 'fetch', 'pull', 'restore', 'rev-parse', 'ls-files', 'grep', 'blame'])],
  ['npm', new Set(JS_PM)],
  ['pnpm', new Set(JS_PM)],
  ['yarn', new Set(JS_PM)],
  ['bun', new Set(JS_PM)],
  ['cargo', new Set(['build', 'test', 'check', 'clippy', 'fmt', 'run'])],
  ['go', new Set(['build', 'test', 'vet', 'fmt', 'run'])],
  ['uv', new Set(['sync', 'pip'])],
  ['pip', new Set(['install', 'list'])],
])

/**
 * (c) 键 = 整条命令(空白折叠):只有一字不差的重复才自动放行。
 * 安装 / 直接运行会拉远程代码或跑任意文件;stash / branch / checkout / switch / restore 会毁掉快照救不回的状态
 * (stash、分支、未提交改动);commit / pull 会跑钩子,而 core.hooksPath 可指向工作区里模型能写的目录(终审 I1)
 */
const EXACT = new Map<string, Set<string>>([
  ['npm', new Set(['install'])],
  ['pnpm', new Set(['install'])],
  ['yarn', new Set(['install'])],
  ['bun', new Set(['install', 'run'])],
  ['pip', new Set(['install'])],
  ['uv', new Set(['pip'])],
  ['go', new Set(['run'])],
  ['git', new Set(['stash', 'branch', 'checkout', 'switch', 'restore', 'commit', 'pull'])],
])

/**
 * 参数指向工作目录外(绝对路径、`..` 路径段(`./...`、`a..b` 不算)、`=/`、盘符,含 `-C/x` 这类紧贴短选项的写法),
 * 或是让 git 跑任意程序的选项(含缩写)→ 没有键;`~`、UNC 与 win32 路径的反斜杠已被字符清单拦下
 */
const OUTSIDE_ARG = [
  /^\//, /(^|[/=:,]|^-[A-Za-z]+)\.\.(\/|$)/, /=\//, /^-[A-Za-z]+\//,
  /^[A-Za-z]:/, /=[A-Za-z]:/,
]
/** git 接受长选项的无歧义缩写(`--upload` = `--upload-pack`):`=` 前的名字至少 5 个字符且是其前缀 → 命中 */
const RUNS_PROGRAM = ['--upload-pack', '--receive-pack', '--exec']
const runsProgram = (word: string) => {
  if (!word.startsWith('--')) return false
  const name = word.split('=')[0]
  return name.length >= 5 && RUNS_PROGRAM.some(o => o.startsWith(name))
}
const reachesOutside = (word: string) => runsProgram(word) || DOT_GLOB.test(word) || OUTSIDE_ARG.some(r => r.test(word))

/** 名单比较用:取 basename、小写(APFS / NTFS 默认不区分大小写)、去掉 Windows 可执行后缀 */
function commandName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '')
}

/**
 * 先过拒绝规则(含字符清单外的字符、成对的 `%`、为空、`VAR=` 开头、第一个词拼写不朴素、
 * 之后任一参数指向工作目录外或是点开头的通配),再查允许清单:
 * BY_NAME 的命令 → 第一个词;BY_PAIR 的命令 + 清单内子命令(不以 `-` 开头)→ 两个词,EXACT 里的 → 整条命令;
 * 其余 → undefined。清单按规范化名字比较,键保留原拼写:`./x/eslint` 与 `eslint` 是不同的键。
 */
export function sessionKey(command: string): string | undefined {
  if (!SAFE_COMMAND.test(command) || CMD_VAR.test(command)) return undefined
  const words = command.trim().split(/[ \t]+/)
  const [first, second] = words
  if (!first || !PLAIN_WORD.test(first)) return undefined
  if (words.slice(1).some(reachesOutside)) return undefined
  // git 的参数里出现通配:模型可写出名为 `--upload-pack=x` 的文件,经通配变成选项 → 没有键
  if (commandName(first) === 'git' && words.slice(1).some(w => w.includes('*'))) return undefined
  const name = commandName(first)
  if (BY_NAME.has(name)) return first
  if (second === undefined || second.startsWith('-') || !BY_PAIR.get(name)?.has(second)) return undefined
  return EXACT.get(name)?.has(second) ? words.join(' ') : `${first} ${second}`
}
