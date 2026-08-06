import { useEffect, useRef, useState } from 'react'

interface TermProxyPaneProps {
  termProxy: string
  onChange: (v: string) => void
}

// Shown ONLY as the input placeholder (a hint), never prefilled into the value: an unsaved box must
// look unsaved. Prefilling this read as "a proxy is configured" when it wasn't — the provider then ran
// direct-connect and 403'd. The 常用 preset chips give first-timers a one-click starting point instead.
const DEFAULT_PROXY = 'http://127.0.0.1:7897'
// termProxy is exported into HTTP_PROXY/HTTPS_PROXY/ALL_PROXY (see buildAgentEnv), so both http://
// and socks5:// work — the latter covers Shadowsocks-style clients that only expose a local SOCKS port.
const COMMON_PROXIES: { label: string; url: string }[] = [
  { label: 'Clash · 7890', url: 'http://127.0.0.1:7890' },
  { label: 'Clash Verge · 7897', url: 'http://127.0.0.1:7897' },
  { label: 'V2Ray · 1087', url: 'http://127.0.0.1:1087' },
  { label: 'V2RayN · 10809', url: 'http://127.0.0.1:10809' },
  { label: '通用 HTTP · 8080', url: 'http://127.0.0.1:8080' },
  { label: 'Shadowsocks · SOCKS5 1080', url: 'socks5://127.0.0.1:1080' },
  { label: 'SS-NG · SOCKS5 1086', url: 'socks5://127.0.0.1:1086' },
]

export function TermProxyPane({ termProxy, onChange }: TermProxyPaneProps) {
  // The box mirrors exactly what's saved. When nothing is saved it stays EMPTY (the placeholder hints
  // a value) — never prefill an unsaved default, which reads as "a proxy is configured" when it isn't.
  const [value, setValue] = useState(termProxy)
  const [saved, setSaved] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 出口 IP 检测(按需):idle | loading | 结果 | 错误。纯信息展示,失败绝不影响任何 provider。
  const [ipState, setIpState] = useState<'idle' | 'loading' | { ip: string; region: string; via: 'proxy' | 'direct' } | { error: string }>('idle')

  useEffect(() => { setValue(termProxy) }, [termProxy])

  const flashSaved = () => {
    setSaved(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setSaved(false), 1400)
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const commit = (v: string) => {
    setValue(v)
    if (v !== termProxy) { onChange(v); flashSaved() }
  }

  const active = termProxy.trim() !== ''
  // 输入框里的内容和已保存的值不一致 = 有未保存的修改。用户反馈:光靠 onBlur 静默提交,
  // 手动改完之后没有任何东西告诉你"存上了没有",于是习惯性去找保存按钮却找不到。
  // 现在:脏了就明说「未保存」并把保存按钮点亮,存上了就常驻显示「已保存」。
  const dirty = value.trim() !== termProxy

  const detectIp = async () => {
    setIpState('loading')
    try {
      const r = await window.forge.checkExitIp()
      setIpState(r)
    } catch {
      setIpState({ error: '检测失败（超时或网络不可达）' })
    }
  }

  return (
    <div className="set-group">
      <h4>终端代理</h4>
      <p className="set-desc">编码代理的命令行与网络请求将通过此代理转发。支持 http:// 与 socks5://(Shadowsocks 等)。留空则直连。</p>
      {/* Truthful current-state line — reflects the SAVED value, not the editing box, so the user can
          never mistake an unsaved/empty box for an active proxy (the 403 footgun). */}
      <div className={`proxy-current ${active ? 'on' : 'off'}`}>
        <span className="dot" />
        {active ? <>当前：经代理 <code>{termProxy}</code> 转发</> : <>当前：直连（未启用代理）</>}
      </div>
      <div className="proj-field" style={{ marginTop: 12 }}>
        <label htmlFor="termProxy">代理地址</label>
        <div className="proxy-input-row">
        <input
          id="termProxy"
          type="text"
          placeholder={DEFAULT_PROXY}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          value={value}
          onChange={e => setValue(e.target.value)}
          onBlur={() => commit(value.trim())}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(value.trim()) } }}
        />
        {/* 显式保存按钮。onBlur 依然会提交(改完点别处一样生效),这个按钮是给"改完想确认一下"的手感。 */}
        <button
          type="button"
          className="proxy-save"
          disabled={!dirty}
          title={dirty ? '保存代理地址' : '没有未保存的修改'}
          onClick={() => commit(value.trim())}
        >{dirty ? '保存' : '已保存'}</button>
        </div>
      </div>
      <div className="proxy-presets" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
        <span style={{ fontSize: 12, color: 'var(--faint)', alignSelf: 'center' }}>常用:</span>
        {COMMON_PROXIES.map(p => (
          <button
            key={p.url}
            type="button"
            className={`wf-pick${value === p.url ? ' on' : ''}`}
            title={`使用 ${p.url}`}
            onClick={() => commit(p.url)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="proxy-foot">
        {/* 常驻状态行 —— 原先这里只有一枚闪 1.4s 的「已保存」,绝大多数时候是隐形的,等于没有反馈。 */}
        <span className={`proxy-status on${dirty ? ' dirty' : ''}${saved ? ' saved' : ''}`}>
          <span className="dot" />
          {dirty ? '有未保存的修改 —— 按回车或点「保存」' : saved ? '已保存' : '已保存(与当前生效值一致)'}
        </span>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => commit('')}
        >
          清空 · 直连
        </button>
      </div>
      {/* 出口 IP 检测 —— 按需信息展示。走当前代理(有则经代理、无则直连),纯查看你的公网出口落在哪个地区,
          不参与 provider 启动、不影响执行。 */}
      <div className="proxy-exitip">
        <button type="button" className="btn-ghost" disabled={ipState === 'loading'} onClick={() => void detectIp()}>
          {ipState === 'loading' ? '检测中…' : '检测出口 IP'}
        </button>
        {typeof ipState === 'object' && 'ip' in ipState && (
          <span className="proxy-exitip-result">
            出口 IP <code>{ipState.ip}</code>
            {ipState.region ? ` · ${ipState.region}` : ''}
            <span className="proxy-exitip-via">{ipState.via === 'proxy' ? '（经代理）' : '（直连）'}</span>
          </span>
        )}
        {typeof ipState === 'object' && 'error' in ipState && (
          <span className="proxy-exitip-err">{ipState.error}</span>
        )}
      </div>
    </div>
  )
}
