// 写进事件的工具参数与输出按模式打码(spec §6、§16 改动 6)
// 不加词边界:JSON 原文里密钥常紧跟在 `\n`、`\t` 这类转义之后,前一个字符是字母;宁可多打码

const PATTERNS: RegExp[] = [
  // PEM 私钥;没有 END(被截断)时打码到结尾
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[\s\S]*)/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
]

export function redact(s: string): string {
  let out = s
  for (const re of PATTERNS) out = out.replace(re, '***')
  return out
}
