/**
 * codex 报上来的「错误」到底是什么意思 —— 分成**警告**、**能说清的失败**、和**其它**。
 *
 * ★★★为什么需要这一层:codex 把**警告也发成 `type: "error"` 的条目**。2026-09-17 实测,
 *  一次完全成功的调用里就带了两条:
 *    · "`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review…"
 *    · "Skill descriptions were shortened to fit the skills context budget…"
 *  它们都不是失败。而我们原来把任何 `type: 'error'` 都当失败,于是一次跑通的回合完全可能
 *  被显示成「错误: Skill descriptions were shortened…」—— 而那句话什么也没说错,就是不该出现在那儿。
 *
 * ★★第二件事:`Reconnecting... 2/5` 是 **codex 自己的重试计数器**,不是给人看的。
 *  用户看到「错误: Reconnecting... 2/5」完全不知道该干什么(2026-09-17 用户原话:「你知道原因么」)。
 *  它真正的意思是「连不上模型接口,自己重试了都没成功」,而那是**可行动**的:去查网络/代理。
 *
 * ★零 import,纯函数,能在 node 下直接测。
 */

/** 这条「错误」其实只是个警告 —— 不该让一个跑通的回合显示成失败。 */
const WARNING_PATTERNS: RegExp[] = [
  // 钩子信任绕过:是用户自己的配置造成的提示,每一轮都会出现。
  /dangerously-bypass-hook-trust/i,
  // 技能描述被截断:上下文预算的提示,和这一轮成败无关。
  /Skill descriptions were shortened/i,
  // 配置项废弃提醒。
  /is deprecated/i,
]

export function isCodexWarning(message: string): boolean {
  return WARNING_PATTERNS.some((re) => re.test(message))
}

/**
 * 把 codex 的原话翻成一句**能照着做**的中文。翻不了就返回 null,由调用方原样显示 ——
 * ★绝不瞎猜:一句猜错的「原因」比原文更糟,它会把人带去查错的方向。
 */
export function explainCodexError(message: string): string | null {
  const m = message.trim()
  // ★codex 内部的重试计数器。它自己重试到 N/N 仍然失败才会把这条留在最后。
  if (/Reconnecting\.{0,3}\s*\d+\s*\/\s*\d+/i.test(m)) {
    return 'codex 连不上模型接口,它自己重试了几次都没成功。多半是网络或代理 —— '
      + '先看「设置 → 编码代理」,或者在终端里跑一次 `codex exec "hi"` 看看是不是同样连不上。'
      + `\n(codex 原话:${m})`
    }
  // 模型太新,CLI 太旧。★这条 2026-09-16 真撞到过(gpt-5.6-sol + npm 装的 0.139.0)。
  if (/requires a newer version of Codex/i.test(m)) {
    return '这个模型需要更新版本的 codex。跑一次 `npm i -g @openai/codex@latest` 之后重开会话。'
      + `\n(codex 原话:${m})`
  }
  return null
}
