import * as tls from 'node:tls'

/**
 * 让主进程的 TLS(ws 连中转、fetch 检查更新……)也信任**系统证书库**里的根证书。
 *
 * ★★用户 2026-09-22 真机:同事电脑连 `wss://relay.wzcu.com` 报 `self signed certificate in certificate chain`,
 *  而同一个公司网里的另一台电脑连得好好的。中转自己的证书是 Let's Encrypt 签的 —— 那张「自签名」是
 *  那台电脑上的安全软件 / 公司网关做 HTTPS 解密时换上去的。它的根证书由 IT 装进了系统钥匙串,
 *  所以浏览器一切正常;但 Node 默认只认自己打包的那 ~145 个公共根证书,**不读钥匙串**,
 *  于是把它当成了伪造证书。
 *
 * 做法:默认列表 ∪ 系统列表。只**加**不减 —— 公共根证书照旧有效。
 * 中转上跑的是端到端加密(配对时拿到的公钥),解密网关解开的只是外层 TLS,看不到内容。
 *
 * ★必须在任何 TLS 连接建立之前调用(之后新建的连接才会用新列表)。
 * ★Node 22.19 / 24.5 起才有这两个函数;老运行时静默跳过,行为和原来一样。
 */
export function trustSystemCertificates(api: Pick<typeof tls, 'getCACertificates' | 'setDefaultCACertificates'> = tls): number {
  try {
    if (typeof api.getCACertificates !== 'function' || typeof api.setDefaultCACertificates !== 'function') return 0
    const system = api.getCACertificates('system')
    if (!system.length) return 0
    const merged = [...new Set([...api.getCACertificates('default'), ...system])]
    api.setDefaultCACertificates(merged)
    return system.length
  } catch {
    // 读系统证书库失败(权限 / 平台差异)不能拖垮启动 —— 退回只用内置列表,和原来一样。
    return 0
  }
}
