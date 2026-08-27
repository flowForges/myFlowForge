/**
 * 输入框里的斜杠命令 —— 「什么时候该开这个面板、开了显示哪几条」。
 *
 * 背景:真机上用户原话「输入框,输入 / 好像加载不到支持的命令」。手机端在这之前**一条都没有** ——
 * `commands:list` 这个 channel 电脑端天天在用(`WorkspaceView.tsx:439` 调 `commandsList(agentId, wsPath)`),
 * 手机端从来没接过。所以这不是回归,是缺的那一半。
 *
 * ★★规则**照抄电脑端** `src/renderer/views/chat/slashCommands.ts` 的 `isSlashQuery` / `mergeCommands`,
 *  一个字都不许自己发明:两边是同一个人在同一天里换着用的两块屏幕,「电脑上打 /架 出来一条、
 *  手机上打 /架 什么都没有」比没有这个功能更让人不信任。手机端**不能**直接 import 那份 ——
 *  那是 renderer 层的东西(`mobile` 只跨到 `src/shared`),同 `listContinue.ts` 的处境。
 *
 * ★这个文件刻意**不 import 任何东西**(同 `autoScroll.ts` / `listContinue.ts` / `gatePeek.ts`):
 *  `mobile` 那个 vitest project 是 node 环境,加载不了 react-native。判据留在组件里 = 一行覆盖都没有。
 *
 * ★手机端**只上主机真有的那几条**(on-disk 命令 + 已装技能),不搬电脑端那张内置 `SLASH_COMMANDS` 表:
 *  那张表里的 `/开启工作流` 在手机上已经有自己的入口(输入区的 `/ 工作流` chip),其余几条是往
 *  输入框里塞一段中文提示词 —— 这一轮用户点名的是「加载不到支持的命令」,指的就是主机上那些。
 *  真要把内置那几条也搬过来,得先把那张表挪进 `src/shared`,两端共用,而不是在手机端抄一份。
 */

/** `commands:list` 回来的一条。字段名和电脑端 `ProviderCommand` 完全一致(同一个 handler 的返回值)。 */
export type SlashCommand = {
  /** `/analyst` —— 带斜杠,展示 + 匹配都用它 */
  cmd: string
  title: string
  /** frontmatter 里的 description,可能是空串 */
  desc: string
  /** 选中后填进输入框的内容 */
  template: string
  kind: 'command' | 'skill'
}

/**
 * 输入框里现在这段字**还在打一条斜杠命令**吗:以 `/` 开头,而且还没出现任何空白。
 *
 * ★空格一出现就关掉面板 —— 那之后人在写参数(`/analyst 看一下登录流程`),不是在挑命令。
 *  和电脑端 `isSlashQuery` 逐字一致。
 * ★判的是**整段正文**而不是「光标所在的那一行」:斜杠命令只在开头成立,一段话中间的
 *  `/usr/bin` 不该弹面板。
 */
export function isSlashQuery(text: string): boolean {
  return text.startsWith('/') && !/\s/.test(text)
}

/**
 * 按已经打出来的这段 `/xxx` 过滤。命令名(去掉斜杠)或标题**包含**这段字就算命中,不分大小写。
 *
 * ★用 `includes` 不用 `startsWith`,和电脑端 `mergeCommands` 一致:自定义命令名常常是
 *  `pr-review` 这种带前缀的,只记得住后半截的时候得也能搜到。
 * ★只打了一个 `/`(query 去掉斜杠后是空)就是**全都给**,不是一条都不给。
 */
export function filterCommands<C extends { cmd: string; title: string }>(cmds: readonly C[], query: string): C[] {
  const q = query.replace(/^\//, '').trim().toLowerCase()
  if (!q) return cmds.slice()
  return cmds.filter((c) => c.cmd.slice(1).toLowerCase().includes(q) || c.title.toLowerCase().includes(q))
}

/**
 * 这一刻该显示的那几条。`false` = 整个面板不摆。
 *
 * ★**主机没有这个方法时(`supported` 为假)一条都不给** —— 摆一个空面板等于说「有这个功能,
 *  只是你一条命令都没有」,而真相是这台主机的版本里根本没有 `commands:list`。
 *  同 `pickSupport.ts` / `copy.ts` 那条规矩:说明了原因的「没有」,好过一个点了没反应的控件。
 *  面板本身也只在**有行**的时候才画(调用方判 `length`),所以空列表天然不摆。
 * ★`dismissed`:选中一条之后把面板收起来。多数模板末尾带空格(`/analyst `),`isSlashQuery`
 *  下一拍就自己变假了;但技能那种模板是一段中文、而万一某条模板正好是个光秃秃的 `/foo`,
 *  没有这个闸门面板会当场又弹回来 —— 电脑端 `slashDismissed` 就是为这个存在的。
 */
export function slashRows<C extends { cmd: string; title: string }>(
  cmds: readonly C[],
  text: string,
  opts: { supported: boolean; dismissed: boolean },
): C[] {
  if (!opts.supported || opts.dismissed || !isSlashQuery(text)) return []
  return filterCommands(cmds, text)
}
