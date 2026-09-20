/**
 * 「现在左滑开着的是哪一行」—— 全 app 只有一行能开着。
 *
 * ★★2026-08-29 真机第六轮。用户原话:「左滑是可以看到 归档、重命名、置顶等,然后没有做任何
 *  动作,再点击其他的工作区,这个效果应该收回去,而不是需要我自己一一收回去」。
 *  `ReanimatedSwipeable` 每一行各管各的,彼此不知道对方存在 —— 于是可以滑开五行,五排动作格
 *  同时摊在那儿,而列表本身还长得像正常列表。微信/邮件那类列表全都是「开第二行时第一行自己收」。
 *
 * ★为什么是模块级的一个变量而不是 React context:这条状态**不该引起任何重渲染**。
 *  收起是命令式的(去调那一行 swipeable 的 `close()`),不是「渲染出收起的样子」;
 *  放进 state 会让整张列表在每次滑开/收起时重渲染一遍,而列表正是滑动最频繁的地方。
 *
 * ★零 RN import,所以能在 node 那套 vitest 里直接测。
 */

/** 一行左滑面板对外只暴露「把自己收起来」这一个能力。用对象身份认人,不用 id。 */
export type SwipeHandle = { close: () => void }

let openHandle: SwipeHandle | null = null

/**
 * 某一行刚滑开了:收掉上一行,记下自己。
 *
 * ★**先把自己记进去,再去收上一行**。`close()` 会同步引出上一行的收起回调、那条路又会调
 *  `releaseSwipeOpen` —— 先记下自己的话,那次 release 拿 `prev` 比对当前的 `h`,不相等,原样返回;
 *  反过来先 close 再赋值也能work(release 会把 `prev` 清成 null,随后再赋成 `h`),
 *  但那要多绕一次「清空又填上」。两种写法都对,选现在这种是因为读起来只有一个方向。
 * ★`prev !== h` 的自比对是必须的:RNGH 会在一次手势里发不止一次 willOpen,
 *  没有这一层的话一行会把**自己**收掉,滑开立刻弹回去。
 */
export function claimSwipeOpen(h: SwipeHandle): void {
  const prev = openHandle
  openHandle = h
  if (prev && prev !== h) prev.close()
}

/**
 * 某一行自己收起来了(或者整行被卸载了)。★必须比对身份:一行 A 收起的事件可能在 B 滑开
 * **之后**才到(RNGH 的 willOpen/willClose 是两套动画各自的回调,不保证交错顺序),
 * 不比对的话 A 的这次收起会把 B 从注册表里抹掉,B 从此收不掉了。
 */
export function releaseSwipeOpen(h: SwipeHandle): void {
  if (openHandle === h) openHandle = null
}

/**
 * 「有开着的就收掉」。返回值 = **这一下点击是不是被这次收起吃掉了**。
 *
 * ★调用方(行的 onPress)拿到 true 就该原地返回、不要再执行本来的动作。这是列表类界面的
 *  通行规矩:开着动作格的时候,第一下点击的语义是「算了,收起来」,而不是「进这一行」——
 *  否则人想取消,反而误入了另一个工作区。
 */
export function closeOpenSwipe(): boolean {
  const h = openHandle
  if (!h) return false
  openHandle = null
  h.close()
  return true
}

/** 测试用:把注册表清干净。生产代码不要调。 */
export function resetSwipeRegistry(): void {
  openHandle = null
}
