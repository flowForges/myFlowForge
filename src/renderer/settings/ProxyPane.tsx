import { TermProxyPane } from './TermProxyPane'

/**
 * 代理设置。★Q4:原本一个值同时被两拨人用 —— agent 的出口(跑在**那台机器**上)和 app 自身的
 * 网络(检查更新/拉壁纸/拉插件目录,由**你面前这台设备**发出)。远程之后这俩必然不同:
 * 云服务器不需要代理,你的笔记本需要。所以拆成两段,而且分属两边。
 *
 * 复用同一个 TermProxyPane —— 它那套「检测出口 IP / 常用地址 / 如实的保存状态」是踩出来的,
 * 两段都该有,不该为了拆分重写一遍。
 *
 * ★★但复用必须把**标题和出口检测的对象**一起传下去。2026-09-11 用户原话:「有两套一模一样的
 *  设置代理和检查出口,很让人懵逼啊」—— 当时 TermProxyPane 自带写死的 `<h4>终端代理</h4>` 和
 *  同一句说明,这里又在它外面各摆了一个小标题,于是一屏上出现四个标题、两块长得完全一样的面板;
 *  更糟的是两个「检测出口 IP」按钮问的是同一条代理(主进程只认 agentProxy),下面那个在说谎。
 */
export function ProxyPane({ agentProxy, appProxy, onChange }: {
  agentProxy: string
  appProxy: string
  onChange: (patch: { agentProxy?: string; appProxy?: string }) => void
}) {
  return (
    <div>
      <TermProxyPane
        scope="agent"
        title="编码代理的出口 · 跟机器走"
        desc="agent(codex / claude 等)跑在你当前连着的那台机器上,这条是它访问外网时用的;切到别的主机会看到那台自己的设置。"
        termProxy={agentProxy}
        onChange={(v) => onChange({ agentProxy: v })}
      />
      <div style={{ marginTop: 24 }}>
        <TermProxyPane
          scope="app"
          title="应用自身的网络 · 跟这台设备走"
          desc="检查更新、下载字体、拉壁纸和宠物市场走的是这一条 —— 这些请求由你面前这台设备发出,和远程主机无关,连去哪台机器都不会变。"
          termProxy={appProxy}
          onChange={(v) => onChange({ appProxy: v })}
        />
      </div>
    </div>
  )
}
