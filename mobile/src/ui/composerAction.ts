/**
 * 输入行最右边那颗键此刻是「发送」还是「停止」,以及输入框该写什么提示。
 *
 * ★★2026-10-06 用户报:手机上这一轮还在跑时,新打的字**发不出去** —— 那颗键整个变成了停止键,
 *  于是想排一条后续指令只能干等这一轮结束。后端其实早就支持:`chat:send` 走的是工作区队列,
 *  忙的时候自动排队(桌面端天天在用),手机端缺的只是界面上这一条判断。
 * ★规则和桌面端对齐(renderer/views/chat/Composer.tsx 的 `running && !text.trim()`):
 *  **有字就一定是发送**,空着才是停止。手机上没有 Esc 键,所以「清空输入框」就是回到停止键的那条路。
 * ★抽成纯函数而不是写在 chat.tsx 的 JSX 里:手机端的测试跑不了组件渲染(全是纯逻辑测试),
 *  抽出来才测得到 —— 而这正是出过 bug 的那一行。
 */
export type ComposerAction = 'send' | 'stop'

export function composerAction(a: { busy: boolean; hasText: boolean }): ComposerAction {
  return a.busy && !a.hasText ? 'stop' : 'send'
}

export function composerPlaceholder(a: { online: boolean; busy: boolean; interjecting?: boolean; councilBreak?: boolean }): string {
  // 离线最优先:连不上的时候谈排队没有意义。
  if (!a.online) return '未连接 · 发不出去'
  // AI 共商进行中:提交的是插话;轮间等用户时是「补充」(引擎把它归到下一轮)。同电脑端。
  if (a.interjecting) return a.councilBreak ? '补充' : '插话'
  // ★这句话必须在场:不说的话,用户按下发送看到的是「这一轮还在跑」,很容易以为自己那条没发出去。
  if (a.busy) return '当前任务执行中… 继续输入将排队'
  return '给代理下达任务…'
}
