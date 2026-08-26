/**
 * 「`open` 是不是刚从 false 跳到 true」—— `BigEditor` 要不要拿外面的 `value` 重新起草的
 * 唯一判据。
 *
 * ★为什么单独一个文件:这条判据就是整个组件「取消能丢弃编辑」这条承诺的全部逻辑 ——
 *  `open` 保持 true 期间(外面因为别的 state 重渲染、`value` 引用跟着变)绝不能重新取值,
 *  不然「取消」就变成一句假话:草稿被调用方的值盖掉,人以为丢弃了、其实早就写回去了。
 *  这条判据本身不碰任何 react-native 的东西,和 `autoScroll.ts`/`timeSep.ts` 一样刻意
 *  **不 import 任何东西**,好让它能在 node 环境的 `mobile` vitest project 里单测 ——
 *  真机点验才能看到的东西,不该是保护这条承诺的唯一手段。
 */
export function shouldReseed(open: boolean, prevOpen: boolean): boolean {
  return open && !prevOpen
}
