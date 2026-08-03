// Rough, dependency-free token estimator used as a FALLBACK for the token-usage ledger when a provider
// doesn't report real usage (qoder/codex/cursor/gemini/…). Not exact — no model tokenizer — but good
// enough to make "用量" reflect context consumption for every provider.
//
// Heuristic: CJK (Han/Kana/Hangul) characters are ~1 token each; other characters average ~4 per token
// (the common GPT/Claude rule of thumb for Latin text). Whitespace is ignored so the count is stable.
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿ｦ-ﾝ]/

export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/\s/.test(ch)) continue
    if (CJK.test(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}
