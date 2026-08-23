import { TermProxyPane } from './TermProxyPane'

/**
 * 代理设置。★Q4:原本一个值同时被两拨人用 —— agent 的出口(跑在**那台机器**上)和 app 自身的
 * 网络(检查更新/拉壁纸/拉插件目录,由**你面前这台设备**发出)。远程之后这俩必然不同:
 * 云服务器不需要代理,你的笔记本需要。所以拆成两段,而且分属两边。
 *
 * 复用同一个 TermProxyPane —— 它那套「检测出口 IP / 常用地址 / 如实的保存状态」是踩出来的,
 * 两段都该有,不该为了拆分重写一遍。
 */
export function ProxyPane({ agentProxy, appProxy, onChange }: {
  agentProxy: string
  appProxy: string
  onChange: (patch: { agentProxy?: string; appProxy?: string }) => void
}) {
  return (
    <div>
      <div className="set-group" style={{ paddingBottom: 0 }}>
        <h4>编码代理的出口 · 跟机器走</h4>
        <p className="set-desc">
          agent 跑在你当前连着的那台机器上,这条是它访问外网时用的。切到别的主机会看到那台自己的设置。
        </p>
      </div>
      <TermProxyPane termProxy={agentProxy} onChange={(v) => onChange({ agentProxy: v })} />

      <div className="set-group" style={{ paddingBottom: 0, marginTop: 24 }}>
        <h4>应用自身的网络 · 跟这台设备走</h4>
        <p className="set-desc">
          检查更新、下载字体、拉壁纸和宠物市场走的是这一条 —— 这些请求由你面前这台设备发出,
          和远程主机无关,所以连去哪台机器都不会变。
        </p>
      </div>
      <TermProxyPane termProxy={appProxy} onChange={(v) => onChange({ appProxy: v })} />
    </div>
  )
}
