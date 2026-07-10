const GITHUB_URL = 'https://github.com/xzghua/myFlowForge'

// 「关于」面板:应用名 / 版本 / 简介 + 跳转 GitHub 项目首页(经主进程用系统浏览器打开)。
export function AboutPane({ version }: { version?: string }) {
  return (
    <>
      <div className="set-group">
        <h4>关于</h4>
        <div className="about-card">
          <div className="about-logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 2 2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5M2 12l10 5 10-5" /></svg>
          </div>
          <div className="about-meta">
            <div className="about-name">myFlowForge</div>
            <div className="about-ver">{version ? `v${version}` : ''}</div>
            <div className="about-desc">本地多代理开发工作流编排 —— 主代理拆解任务、编排子代理执行,你只需给出需求与反馈。</div>
          </div>
        </div>
        <div className="set-row">
          <div className="info">
            <div className="t">项目主页</div>
            <div className="d">在 GitHub 上查看源码、提交 issue 或参与贡献。</div>
          </div>
          <button className="wf-pick" onClick={() => { void window.forge.openExternal(GITHUB_URL) }}>
            <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 15, height: 15, marginRight: 6, verticalAlign: '-2px' }}><path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.5v-1.8c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.7 18.3 5 18.3 5c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.6.8.5 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z" /></svg>
            打开 GitHub 项目首页
          </button>
        </div>
      </div>
    </>
  )
}
