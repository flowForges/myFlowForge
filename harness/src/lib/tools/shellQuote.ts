// POSIX 引用:把 argv 拼成一条 `sh -c` 命令(04 spec §5、§8.2)。每个词都用单引号,里面没有任何字符有特殊含义
export function shellQuote(args: readonly string[]): string {
  return args
    .map(a => {
      if (a.includes('\0')) throw new Error('shellQuote: argument contains a NUL')
      return `'${a.replace(/'/g, `'\\''`)}'`
    })
    .join(' ')
}
