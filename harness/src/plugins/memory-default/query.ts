// 查询构造(06 spec §5):用户和模型写的东西一律当字面文本,进 MATCH 前都包引号。全部按码点算
import { cleanText } from '../../lib/tools/diagnostics'

const MAX_TERMS = 24
const MIN_MATCH = 3
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
const WORD = /[\w.:/-]{3,}/g

// NUL 会让 FTS5 在字符串中间停下,引号就不成对了
const clean = (q: string) => cleanText(q).replace(/\0/g, '')

/** FTS5 字符串:内部引号写两遍 */
export const quote = (term: string) => `"${term.replace(/"/g, '""')}"`

const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, c => `\\${c}`)}%`

export interface BuiltMatch {
  /** ≥3 字的词,AND;trigram 搜不到更短的 */
  match?: string
  /** 1–2 字的词,配 `LIKE ? ESCAPE '\'` */
  likes: string[]
  terms: string[]
}

export function buildMatch(q: string): BuiltMatch {
  const terms = clean(q).split(/\s+/).filter(Boolean).slice(0, MAX_TERMS)
  const long = terms.filter(t => [...t].length >= MIN_MATCH)
  return {
    ...(long.length > 0 && { match: long.map(quote).join(' AND ') }),
    likes: terms.filter(t => [...t].length < MIN_MATCH).map(likePattern),
    terms,
  }
}

/** 自然语言的 OR 模式:拉丁词和数字最能区分,排在滑窗前面,不被上限挤掉 */
export function windowTerms(q: string, max = MAX_TERMS): string[] {
  const text = clean(q)
  const out = new Set<string>(text.match(WORD) ?? [])
  for (const run of text.match(CJK_RUN) ?? []) {
    const chars = [...run]
    for (let i = 0; i + MIN_MATCH <= chars.length; i++) out.add(chars.slice(i, i + MIN_MATCH).join(''))
  }
  return [...out].slice(0, max)
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** 第一个命中前后各 radius 个码点;snippet() 按 trigram 数 token,会把 `10.0.0.5:5432` 切坏 */
export function excerpt(text: string, terms: string[], radius = 80): string {
  const words = terms.filter(Boolean)
  const hit = words.length > 0 ? new RegExp(words.map(reEscape).join('|'), 'iu').exec(text) : null
  if (!hit) {
    const chars = [...text]
    return chars.length <= radius * 2 ? text : `${chars.slice(0, radius * 2).join('')}…`
  }
  const before = [...text.slice(0, hit.index)]
  const after = [...text.slice(hit.index + hit[0].length)]
  return (
    (before.length > radius ? '…' : '') +
    before.slice(Math.max(0, before.length - radius)).join('') +
    hit[0] +
    after.slice(0, radius).join('') +
    (after.length > radius ? '…' : '')
  )
}
