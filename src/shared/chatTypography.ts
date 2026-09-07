/**
 * 会话正文的排版默认值 —— **单一事实源**。
 *
 * ★★这两个数原来各自散在 7 个地方(config/schema.ts 的 preprocess 兜底 / .catch / .default、
 *  schema 的 DEFAULTS、renderer 的 useSettings、pet 的 DEFAULT_APPEARANCE、applyTheme 的兜底,
 *  外加 AppearancePane 里那句「建议 1.7」的文案)。散着的代价有两层:
 *   ① 改一处就会出现「设置里写着建议 1.75、实际渲染 1.7」这种自相矛盾;
 *   ② 更要命的是 schema 里那个 `.default()` —— 它会把值**写进**每个人的 settings.json,
 *     所以只改渲染层的默认值对**任何人**都不生效,包括新用户。
 *  合成一个常量,以后改这一处就够。
 *
 * 1.75 / 14px 是 2026-09-07 按用户给的参考界面定的:原来是 1.7 / 10px,一大段中文糊成一片。
 */
export const CHAT_LINE_HEIGHT_DEFAULT = 1.75
/** 段间距(px)。CSS 那边 `.msg-body p { margin-bottom }` 用的是同一个数,改这里记得一起改。 */
export const CHAT_PARAGRAPH_GAP_DEFAULT = 14
