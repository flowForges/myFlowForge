/**
 * 权限门审计消息里那一行「是什么请求」。
 *
 * ★★2026-09-04 的 bug:`where` 是**原样的 shell 命令或文件路径**,而这条消息是当作
 *  **markdown** 正文发进对话区的。于是命令里的 markdown 元字符全被当成标记吃掉了 ——
 *  用户截图里 `internal/…/entity/recruit_apply_order.go` 渲染成了
 *  `recruit` + 斜体 `apply` + `order.go`,**文件名当场变成一个不存在的路径**。
 *  同理会中招的还有 `*`(斜体/加粗)、`` ` ``(行内代码)、`[文字](链接)`。
 *  一条「审计痕迹」把被审计的命令改写了,这比不显示更糟。
 *
 * ★所以 `where` 一律进**代码围栏**:围栏里 markdown 一个字都不解释,而且多行命令的换行
 *  也保住了(原来是拼成一行长文,截图里那三条就是这么糊成一坨的)。
 * ★不用行内反引号:渲染器是**按行**切块再解析行内标记的,多行命令用行内码会从第二行开始漏出来。
 * ★围栏不写语言:`where` 也可能是一个纯文件路径,给它套 `sh` 高亮只会更乱。
 */
export function gateNoteBody(g: { title: string; where?: string }): string {
  const where = g.where?.trim()
  if (!where) return g.title
  // ★围栏要比内容里最长的那串反引号还长一位(CommonMark 的规矩)——命令里出现 ``` 不是稀奇事
  //   (`echo '```'`、粘一段 markdown 进来),用死的三个反引号会被内容从中间劈开。
  const longest = Math.max(0, ...[...where.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${g.title}\n${fence}\n${where}\n${fence}`
}
