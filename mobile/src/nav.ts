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

/**
 * 回主机列表。
 *
 * ★**别用 `goBack()`。** 扫码那条路会在返回栈里留下**两个** `/add-host`:
 *  「扫一扫」是 `push('/scan')`,而 `Scanner.tsx` 解完码是 `replace('/add-host', 参数)` ——
 *  replace 换掉的是 `/scan` 那一层,于是栈成了 `[/, /hosts, /add-host, /add-host(带参)]`。
 *  `goBack()` 只弹掉带参那个,人落回下面那个**空的添加页** —— 这就是真机验收当场报的
 *  「扫码加完主机停在一个空白页」。
 *
 * `dismissTo` 一路弹到栈里已有的 `/hosts`(把中间那些 add-host 一并弹掉);
 * 栈里根本没有 `/hosts` 时(用手机自带相机扫码、深链冷启动直接落在添加页)它退化成
 * `replace` —— 两种情况都落在主机列表上,都还能继续往回退。
 */
export function goToHosts(): void {
  router.dismissTo('/hosts')
}
