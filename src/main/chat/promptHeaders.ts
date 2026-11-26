// 我方拼进 prompt 开头的那几段的抬头(见 chatService 的 promptText)。会话互通靠它们认出外部记录里「我方的」用户记录 ——
// 只发了附件、整条只有历史 / 指令时没有正文可比对(sessionLink/binding.ts isOwnPrompt)。改这里的字样两边一起变。
export const HISTORY_TITLE = '【历史对话(续)】'
export const INCREMENTAL_HISTORY_TITLE = '【你离开期间本会话继续了以下对话】'
export const STAGE_TITLE_PREFIX = '【工作流「'
export const MEMORY_TITLE = '# 记忆上下文(供参考,不要复述)'
export const INLINE_HTML_TAG = '<format-html-visual>'
export const OWN_PROMPT_HEADERS = [INLINE_HTML_TAG, STAGE_TITLE_PREFIX, HISTORY_TITLE, INCREMENTAL_HISTORY_TITLE, MEMORY_TITLE] as const
