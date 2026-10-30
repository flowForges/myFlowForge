// allow_session 的键(spec §10):内核审批与 tools-registry 共用,纯函数

/** 含这些的命令永不自动放行:`; & | \` $( > <` 与换行 */
const META = /[;&|`<>\n\r]|\$\(/
const SUBCOMMAND = /^[A-Za-z][\w:.-]*$/

/** 前两个词(第二个词像子命令时),否则第一个词;含 shell 元字符或为空 → undefined */
export function sessionKey(command: string): string | undefined {
  if (META.test(command)) return undefined
  const words = command.trim().split(/\s+/)
  if (!words[0]) return undefined
  return words.length > 1 && SUBCOMMAND.test(words[1]) ? `${words[0]} ${words[1]}` : words[0]
}
