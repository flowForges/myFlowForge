// 入库和进上下文之前的打码(06 spec §11):先 cleanText,再 redact,再记忆专用的模式表。
// 规则宁可多打:这里只影响记忆里的副本,用户的文件和事件日志不经过它。
// 每个正则都要在 1 MB 的恶意输入上保持线性,所以会失败的长串前面都有左边界
import { cleanText } from '../tools/diagnostics'
import { redactCounted, SECRET_BOUNDARY } from '../tools/redact'

const MASK = '***'

const PREFIXED = new RegExp(
  SECRET_BOUNDARY +
    '(?:' +
    [
      'glpat-[A-Za-z0-9_-]{20,}',
      '[sr]k_(?:live|test)_[A-Za-z0-9]{16,}', // Stripe
      'npm_[A-Za-z0-9]{30,}',
      'hf_[A-Za-z0-9]{30,}',
      'AIza[0-9A-Za-z_-]{35,}',
      String.raw`ya29\.[0-9A-Za-z_-]{20,}`,
      'ASIA[0-9A-Z]{16}',
      String.raw`\d{6,16}:[A-Za-z0-9_-]{30,}`, // Telegram 机器人令牌:id 可到 52 位,密文部分文档写 35 位,放宽到 30
    ].join('|') +
    ')',
  'g',
)

// 左边界比 SECRET_BOUNDARY 严:`-` 也在字符集里,否则 `eyJ-eyJ-…` 每个头都要扫到底
const JWT = new RegExp(String.raw`(?:(?<![A-Za-z0-9_-])|(?<=\\[nrtbf]))eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*`, 'g')

/** 把小写字母写成不分大小写的字符类:驼峰的左边界要分大小写,不能用 i 标志 */
const anyCase = (source: string) => source.replace(/[a-z]/g, c => `[${c}${c.toUpperCase()}]`)

// 整个头的值都是秘密,一直到行尾。Set-Cookie 里的 `-` 过得了左边界
const SECRET_HEADER = new RegExp(String.raw`(?<![A-Za-z0-9])((?:${anyCase('authorization|cookie')})(?:\\?["'])?[ \t]*[:=：＝](?![=>])[ \t]*(?:\\?["'])?)([^\n"'\\]+)`, 'g')
const BEARER = new RegExp(String.raw`(?<![A-Za-z0-9])(${anyCase('bearer')}[ \t]+)([A-Za-z0-9._~+/=-]+)`, 'g')

// 主机和端口要逐字留下(spec §11);长度有界,`a:a:a:…` 这种才不会回溯到平方
const URL_ACCOUNT = /:\/\/([^\s/?#]{1,512})@/g

// 左边界和 redact 一样:`\npassword=`、`%26password%3D` 前一个字符是字母或数字
const LABEL = String.raw`(?:${SECRET_BOUNDARY}(?:${anyCase('password|passwd|passphrase|pwd|secret[_-]?key[_-]?base|secret[_-]?key|secret|private[_-]?key|access[_-]?key|api[ _-]?key|credentials?|token')})|(?<=[a-z0-9])(?:Password|Passwd|Passphrase|Pwd|SecretKeyBase|SecretKey|Secret|PrivateKey|AccessKey|ApiKey|Credentials?|Token))`
const LABELLED = new RegExp(
  // 分隔符之后不能是 `=`、`>`:`token === x`、`token => x` 是代码
  String.raw`(${LABEL}(?:\\?["']|%22)?[ \t]*(?:[:：=＝]|:=|%3[DdAa])(?![=>])[ \t]*)(?:(\\?["'])([^\n]{0,4096}?)\2|(\\?["']?)([^\s"'\`\\]+))`,
  'g',
)
// 英文句子:"password is incorrect" 是常见报错,要有数字或符号才算值
const PASSWORD_IS = new RegExp(String.raw`(?<![A-Za-z0-9])((?:${anyCase('password|passwd')})[ \t]+is[ \t]+)(\S*[0-9!@#$%^&*_-]\S*)`, 'g')
const LABELLED_CN = /((?:密码|口令|密钥)(?:(?:是(?!否)|为)[ \t]*[:：=＝]?[ \t]*|[:：=＝][ \t]*|[ \t]+(?=[\x21-\x7e])))(["'“]?)([^\s,，。;；、"'“”]+)/g

/** 代码里的类型和字面量,不是值 */
const NOT_A_VALUE = new Set([MASK, 'string', 'number', 'boolean', 'null', 'undefined', 'true', 'false', 'None', 'nil'])

const LONG_TOKEN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}={0,2}/g
const WORDS = /[A-Z]?[a-z]{2,}|[A-Z]{3,}/g
const HEX = /^[0-9A-Fa-f-]+$/
// 子资源完整性和 lockfile 里的哈希:算法和 base64 长度都要对得上,不是秘密
const INTEGRITY_HASH = /^sha(?:256-[A-Za-z0-9+/]{43}=|384-[A-Za-z0-9+/]{64}|512-[A-Za-z0-9+/]{86}==)$/
const SECTION_MAX = 24

/** 只用于 LONG_TOKEN 里的 ASCII 串;一个 1 MB 的 base64 也只走一遍 */
function shannon(s: string): number {
  const seen = new Uint32Array(128)
  for (let i = 0; i < s.length; i++) seen[s.charCodeAt(i) & 127]++
  let bits = 0
  for (const n of seen) if (n > 0) bits -= (n / s.length) * Math.log2(n / s.length)
  return bits
}

/** 路径:每段都不长,而且是绝对路径或段数够多;随机串里的 `/` 没有这么密 */
function looksLikePath(s: string): boolean {
  const sections = s.split('/')
  return (s.startsWith('/') || sections.length >= 4) && sections.every(p => p.length < SECTION_MAX)
}

/**
 * 几乎全由单词组成:驼峰、下划线、连字符的标识符。0.85 是实测定的:62 字符集的随机串,
 * 32 位有 0.2% 过线(漏打码),40 位 0.1%;线放到 0.75 就漏 4%
 */
function looksLikeWords(s: string): boolean {
  const inWords = s.length - s.replace(WORDS, '').length
  return inWords >= s.replace(/[^A-Za-z0-9]/g, '').length * 0.85
}

/** spec §11 高熵串的判定:同时有大小写和数字、熵 ≥ 4.0;十六进制、UUID、完整性哈希、标识符、路径不算 */
export function isRandomToken(s: string): boolean {
  if (!/[a-z]/.test(s) || !/[A-Z]/.test(s) || !/\d/.test(s)) return false
  if (HEX.test(s) || INTEGRITY_HASH.test(s) || looksLikePath(s) || looksLikeWords(s)) return false
  return shannon(s) >= 4
}

export function scrub(s: string): { text: string; masked: number } {
  const redacted = redactCounted(cleanText(s))
  let masked = redacted.count
  const hit = (replacement: string) => {
    masked++
    return replacement
  }
  const text = redacted.text
    .replace(PREFIXED, () => hit(MASK))
    .replace(JWT, () => hit(MASK))
    .replace(SECRET_HEADER, (m, head: string, value: string) => (NOT_A_VALUE.has(value.trim()) ? m : hit(head + MASK)))
    .replace(BEARER, (m, head: string, value: string) => (value.length >= 20 || (value.length >= 6 && /[^a-zA-Z]/.test(value)) ? hit(head + MASK) : m))
    .replace(URL_ACCOUNT, (m, account: string) => (account.includes(':') ? hit(`://${MASK}@`) : m))
    .replace(LABELLED, (m, head: string, quote: string | undefined, quoted: string | undefined, open: string | undefined, bare: string | undefined) => {
      const value = quoted ?? bare ?? ''
      if (value === '' || NOT_A_VALUE.has(value)) return m
      return hit(quote !== undefined ? `${head}${quote}${MASK}${quote}` : `${head}${open ?? ''}${MASK}`)
    })
    .replace(PASSWORD_IS, (m, head: string, value: string) => (value === MASK ? m : hit(head + MASK)))
    .replace(LABELLED_CN, (m, head: string, open: string, value: string) => (NOT_A_VALUE.has(value) ? m : hit(head + open + MASK)))
    .replace(LONG_TOKEN, m => (isRandomToken(m) ? hit(MASK) : m))
  return { text, masked }
}
