// allow_session 的键(spec §10 + 控制者裁定):内核审批与 tools-registry 共用,纯函数

/** 含这些的命令永不自动放行:`; & | \` $ > <` 与换行 */
const META = /[;&|`<>$\n\r]/
/** 第一个词只许朴素拼写:引号、反斜杠、括号、通配符、~、= 都会让名单比较失效 */
const PLAIN_WORD = /^[\w./+-]+$/
const SUBCOMMAND = /^[A-Za-z][\w:.-]*$/
/** 第二个词含引号 / 反斜杠:子命令可被换个写法绕过(`git "push"`) */
const QUOTED = /['"\\]/

/** 解释器、提权、破坏性命令与"执行另一条命令"的包装器:放行一次等于放行任意脚本 */
const NEVER = new Set([
  'rm', 'sudo', 'su', 'doas',
  'sh', 'bash', 'zsh', 'fish', 'dash', 'pwsh', 'powershell', 'cmd',
  'node', 'deno', 'bun', 'perl', 'ruby', 'php',
  'eval', 'exec', 'env', 'xargs', 'find', 'chmod', 'chown', 'dd', 'mkfs',
  'timeout', 'nohup', 'nice', 'time', 'command', 'builtin', 'stdbuf', 'caffeinate', 'watch', 'script', 'ssh', '.', 'source',
])
const PYTHON = /^python[\d.]*$/

/** 名单比较用:取 basename、小写(APFS / NTFS 默认不区分大小写)、去掉 Windows 可执行后缀 */
function commandName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '')
}

/**
 * 前两个词(第二个词像子命令时),否则第一个词;以下情形 → undefined(永不自动放行):
 * 含 shell 元字符或 `$`、为空、以 `VAR=` 开头、第一个词拼写不朴素、第二个词以 `-` 开头或带引号、
 * 第一个词在 NEVER 名单(或 python*)里。
 */
export function sessionKey(command: string): string | undefined {
  if (META.test(command)) return undefined
  const words = command.trim().split(/\s+/)
  const [first, second] = words
  if (!first || !PLAIN_WORD.test(first)) return undefined
  const name = commandName(first)
  if (!name || NEVER.has(name) || PYTHON.test(name)) return undefined
  if (second === undefined) return first
  if (second.startsWith('-') || QUOTED.test(second)) return undefined
  return SUBCOMMAND.test(second) ? `${first} ${second}` : first
}
