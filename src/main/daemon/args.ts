/**
 * daemon CLI 的参数解析。
 *
 * ★单独抽出来是因为第一版写错过:找命令名时用了「第一个不以 - 开头的参数」,
 * 于是 `--listen 127.0.0.1:6789` 里的**地址**被当成了命令,真跑起来直接报
 * 「不认识的命令: 127.0.0.1:6789」。带值的选项必须把它的值一起跳过。
 */
const VALUED = new Set(['--listen'])

export function parseArgs(argv: string[]): { cmd: string; listen: string | undefined } {
  const args = argv.filter((a) => a !== 'daemon')
  let cmd: string | null = null
  let listen: string | undefined
  // ★不能一找到命令就 break:`pair --listen 0.0.0.0:9000` 是合法写法(pair 要按这个地址
  // 决定打印 SSH 还是令牌),选项在命令后面也得认。
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (VALUED.has(a)) { if (a === '--listen') listen = args[i + 1]; i++; continue }
    if (a.startsWith('--listen=')) { listen = a.slice('--listen='.length); continue }
    if (a.startsWith('-')) continue
    cmd ??= a
  }
  return { cmd: cmd ?? 'start', listen }
}
