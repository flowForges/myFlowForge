import { router } from 'expo-router'
import { ROUTES } from './nav/routes'

/**
 * 返回上一层。**永远别直接用 `router.back()`。**
 *
 * 没有返回栈时(浏览器里刷新过、从推送直接落进某一屏、深链进来的)`back()` 会
 * **静默什么也不做** —— 界面上就是「点了没反应」,而人根本不知道自己踩的是「没有上一层」。
 * 真机上「点会话没反应」「新建会话没反应」两条都是这个。回退到根视图(会话列表)总是对的:
 * 每一层都是从那儿推出来的。
 *
 * ★2026-08-28 tab 化之后这条路仍然成立:`(tabs)` 是**分组**,不进 URL,所以根还是 `/`。
 *  但这个知识现在只准从 `ROUTES` 来 —— 见 routes.ts 的注释。
 */
export function goBack(): void {
  if (router.canGoBack()) router.back()
  else router.replace(ROUTES.home)
}

/**
 * 回主机列表。
 *
 * ★**别用 `goBack()`。** 扫码那条路会在返回栈里留下**两个** `/add-host`:
 *  「扫一扫」是 `push('/scan')`,而 Scanner 解完码是 `replace('/add-host', 参数)` ——
 *  replace 换掉的是 `/scan` 那一层,于是栈成了 `[(tabs), /add-host, /add-host(带参)]`。
 *  `goBack()` 只弹掉带参那个,人落回下面那个**空的添加页** —— 这就是真机验收当场报的
 *  「扫码加完主机停在一个空白页」。
 *
 * ★★2026-08-28 tab 化改了这个函数的做法。原来是 `router.dismissTo('/hosts')` ——
 *  那时候 `/hosts` 是根栈里的一层,弹到它就行。现在 `/hosts` 是 `(tabs)` **里面**的一格,
 *  根栈里根本没有这一层,`dismissTo` 没有目标可弹。
 *  改成两步:先把根栈上压着的那些 add-host / scan **全部弹掉**(回到 tabs),
 *  再 `navigate` 到主机那一格。
 *  `canDismiss()` 那道闸门是给「深链冷启动直接落在添加页、根栈里没有 tabs」那种情况的 ——
 *  那时 dismissAll 没有东西可弹,直接 navigate。
 *
 * ★★这条路径**单测覆盖不到**,必须真机重走一遍完整的扫码流程(见 Step 13)。
 */
export function goToHosts(): void {
  // ★★2026-09-02:`/hosts` **不再是 tab 的一格**了(那一格给了「工作区」),它现在是根栈里的
  //  一层次级屏。所以先 `dismissAll()` 把扫码那条路上堆起来的层清干净,再 `navigate` ——
  //  `dismissAll` 那一半的理由没变(见下面),变的只是终点的性质。
  if (router.canDismiss()) router.dismissAll()
  router.navigate(ROUTES.hosts)
}
