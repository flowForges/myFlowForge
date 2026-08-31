/**
 * 拨中转时该不该走代理、走哪个。
 *
 * ★★2026-08-31 真机撞到的:用户把中转部署到 Cloudflare、地址也填对了,电脑上却**一直「正在连中转」**。
 *  实测把根因钉死了 —— 同一个地址、同一段 `ws` 代码:
 *      直连     → 15 秒**无声无息**(既不报错也不关闭,就是挂着)
 *      走代理   → 立刻连上,中转回 `{"t":"relay","status":"waiting"}`
 *  也就是说中转本身完全正常,是 `relayHost` 拨号时**没走代理**。
 *
 * ★为什么会漏:`ws` **不认 `http_proxy` / `https_proxy` 环境变量**(和 curl/npm 不一样),
 *  不给 agent 它就直连。而仓库里已有的 `makeProxyFetch` 用的是 undici 的 `ProxyAgent` ——
 *  那个只能给 `fetch` 用,给不了 `ws`。于是「app 自身的网络」这条路上,别的地方(字体、壁纸、
 *  更新检查)都过了代理,唯独中转没有。
 *
 * ★★失败方式特别坏:直连一个被墙的地址不会拒绝、不会重置,**就是永远不回**。
 *  界面上只能显示「正在连…」,而那看起来和「地址写错了」「服务没起来」一模一样。
 */

/** 代理地址从哪儿来。 */
export type ProxyPick =
  | { use: true; url: string; from: 'setting' | 'env' }
  /** 不走代理。`why` 是给日志的一句人话 —— 静默直连正是上面那个 bug 的形状。 */
  | { use: false; why: string }

/**
 * 选一个代理地址。
 *
 * ★设置优先于环境变量:从 Dock 点开的 Electron **拿不到 shell 里的 `http_proxy`**
 *  (那是登录 shell 才有的东西),所以设置是主路径。
 * ★环境变量是给**无头 daemon** 兜底的:在服务器上跑的人更习惯 `export https_proxy=...`,
 *  而不是去编辑 `client.json`。两条都认,谁都不会踩空。
 */
export function pickProxy(setting: string | undefined, env: NodeJS.ProcessEnv): ProxyPick {
  const s = (setting ?? '').trim()
  if (s) return { use: true, url: s, from: 'setting' }
  const e = (env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || '').trim()
  if (e) return { use: true, url: e, from: 'env' }
  return { use: false, why: '没有配代理' }
}

/**
 * 这个代理能不能用在这个中转地址上。
 *
 * ★★只有 `wss://` 才套代理。`ws://` 走 CONNECT 隧道要的是另一个 agent(`http-proxy-agent`),
 *  而「需要翻墙才够得到的中转」几乎不可能是明文的 —— 为一个不存在的组合多引一个依赖不值。
 *  ★但**必须说出来**:静默直连正是这次那个「永远转圈」的来源。
 * ★SOCKS 同理:`https-proxy-agent` 不认 socks,`makeContentFetch` 那边也是这么处理的
 *  (它的注释里写着 undici 的 ProxyAgent 是 HTTP-only)。
 */
export function proxyUsable(relayUrl: string, proxyUrl: string): { ok: true } | { ok: false; why: string } {
  if (!/^wss:\/\//i.test(relayUrl.trim())) {
    return { ok: false, why: `中转地址不是 wss://,这条不套代理(直连)` }
  }
  if (!/^https?:\/\//i.test(proxyUrl.trim())) {
    return { ok: false, why: `代理 ${proxyUrl} 不是 http(s):// —— socks 要另一个 agent,这条不套代理(直连)` }
  }
  return { ok: true }
}
