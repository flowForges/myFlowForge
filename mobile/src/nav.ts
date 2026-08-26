import { router } from 'expo-router'

/**
 * 返回上一层。**永远别直接用 `router.back()`。**
 *
 * 没有返回栈时(浏览器里刷新过、从推送直接落进某一屏、深链进来的)`back()` 会
 * **静默什么也不做** —— 界面上就是「点了没反应」,而人根本不知道自己踩的是「没有上一层」。
 * 真机上「点会话没反应」「新建会话没反应」两条都是这个。回退到根视图(全部会话)总是对的:
 * 每一层都是从那儿推出来的。
 */
export function goBack(): void {
  if (router.canGoBack()) router.back()
  else router.replace('/')
}
