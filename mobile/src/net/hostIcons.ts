/**
 * 主机图标 —— **实现搬到了 `src/shared/hostIcons.ts`**,这里只是原样转发。
 *
 * ★★为什么要搬:2026-09-03 电脑端也做了图标选择器(原来是个手打表情的输入框)。
 *  两边**必须是同一份名单** —— 各存一份的话,同一台主机在手机上是「☁️ 服务器」、
 *  在电脑上却成了别的东西,而这种偏差没人会当 bug 报,只会觉得这个 app 做得糙。
 * ★这个文件留着不删:手机端十几处 import 的是这个路径,而这次改动跟它们一点关系都没有。
 */
export { HOST_ICONS, DEFAULT_HOST_ICON, currentHostIcon, isBuiltinHostIcon, type HostIconOption } from '@shared/hostIcons'
