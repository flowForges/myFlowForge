// 写进事件的工具参数与输出按模式打码(spec §6、§16 改动 6)
// 密钥前缀前须是开头 / 非字母数字,或 JSON 转义(`\n`、` ` 等)/ URL 编码(`%3D`)之后——
// JSON 原文里密钥常紧跟在 `\n` 后,前一个字符是字母;普通的 `risk-assessment-…` 不被误打码

const B = String.raw`(?:(?<![A-Za-z0-9])|(?<=\\[nrtbf])|(?<=\\u[0-9A-Fa-f]{4})|(?<=%[0-9A-Fa-f]{2}))`

const PATTERNS: RegExp[] = [
  // PEM 私钥;没有 END(被截断)时打码到结尾
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[\s\S]*)/g,
  new RegExp(B + 'sk-[A-Za-z0-9_-]{16,}', 'g'),
  new RegExp(B + 'github_pat_[A-Za-z0-9_]{20,}', 'g'),
  new RegExp(B + 'gh[pousr]_[A-Za-z0-9]{20,}', 'g'),
  new RegExp(B + 'xox[abprs]-[A-Za-z0-9-]{10,}', 'g'),
  new RegExp(B + 'AKIA[0-9A-Z]{16}', 'g'),
]

export function redact(s: string): string {
  let out = s
  for (const re of PATTERNS) out = out.replace(re, '***')
  return out
}
