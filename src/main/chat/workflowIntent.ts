const WORKFLOW_INTENT_PATTERNS = [
  /按(?:照)?工作流/,
  /工作流(?:的)?(?:方式|形式|模式)/,
  /以工作流/,
  /跑工作流/,
  /启动工作流/,
  /发起工作流/,
  /(?:开启|打开|启用)工作流/,
  /按流程执行/,
  /多代理(?:执行|开发|处理)/,
]

// 「(使/采)用工作流」only counts when the few characters right before the match carry no negation —
// lookbehind-per-form can't enumerate 「不要使用/别使用/不采用/无需使用/不能用…」, a window check can.
// Blocking a rare affirmative (e.g. 「特别要用工作流」) is safer than auto-starting a declined run.
const USE_WORKFLOW_RE = /(?:使|采)?用工作流/g
const NEGATION_BEFORE = /不|别|勿|无需|没必要/

function hasAffirmativeUseWorkflow(t: string): boolean {
  USE_WORKFLOW_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = USE_WORKFLOW_RE.exec(t))) {
    if (!NEGATION_BEFORE.test(t.slice(Math.max(0, m.index - 4), m.index))) return true
  }
  return false
}

export function isWorkflowIntent(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return WORKFLOW_INTENT_PATTERNS.some(re => re.test(t)) || hasAffirmativeUseWorkflow(t)
}

// Explicit "continue/resume the workflow" phrasings. Kept conservative and only ever acted on when a
// resumable (cancelled/failed) run actually exists, so false positives can't spuriously start a run.
const RESUME_INTENT_PATTERNS = [
  /继续(?:执行|运行|跑|工作流|吧|完成|做|往后|往下)?/,
  // 接着 [之前/上次/刚才/往后/往下] … 执行/做 — tolerate a few chars in between so "接着之前往后做"、
  // "接着往后执行" 都能命中,而不是只认 "接着做"。
  /接着(?:之前|上次|刚才|往后|往下)?.{0,4}?(?:执行|运行|跑|做|干|完成|推进)/,
  // 往后/往下(面) 执行/做/走/推进/搞 — "往后执行"、"往下做"、"往后推进"。
  /往(?:后|下)(?:面|边)?.{0,3}?(?:执行|运行|跑|做|走|推进|搞|继续|干)/,
  /从(?:上次|之前|刚才)继续/,
  /重新继续/,
]

export function isResumeIntent(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return RESUME_INTENT_PATTERNS.some(re => re.test(t))
}
