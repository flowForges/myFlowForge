// 流式时只发"稳定"的部分(07 spec §9.4):编辑会把半截密钥发出去,下一次才被盖住,所以半截的先不发。

export const RISK = /password|passwd|pwd|secret|token|api[ _-]?key|credential|authorization|bearer|cookie|密码|口令|密钥|:\/\/|eyJ|-----BEGIN/i

/** 第一个没有 END 跟着的 BEGIN */
function openPem(acc: string): number {
  let from = 0
  for (;;) {
    const b = acc.indexOf('-----BEGIN', from)
    if (b < 0) return -1
    const e = acc.indexOf('-----END', b)
    if (e < 0) return b
    from = e + 8
  }
}

export function stableText(acc: string, final: boolean): string {
  if (final) return acc
  let end = acc.length
  const pem = openPem(acc)
  if (pem >= 0) end = pem
  // 当前行(切点所在的行)有风险标记:只发到上一行
  const lineStart = acc.lastIndexOf('\n', end - 1) + 1
  if (end > lineStart && RISK.test(acc.slice(lineStart, end))) end = lineStart
  // 结尾连续的 ASCII 非空白串:密钥都是 ASCII,中文不受影响
  let i = end
  while (i > 0) {
    const c = acc.charCodeAt(i - 1)
    if (c < 0x21 || c > 0x7e) break
    i--
  }
  return acc.slice(0, i)
}
