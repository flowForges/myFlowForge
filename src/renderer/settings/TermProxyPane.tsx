import { useEffect, useRef, useState } from 'react'

interface TermProxyPaneProps {
  termProxy: string
  onChange: (v: string) => void
}

// A sensible default + the ports the common local proxies listen on, so a first-time user gets an
// editable starting point instead of an empty box whose placeholder vanishes the moment they type.
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
  // When nothing is saved yet, prefill the box with a default the user can edit directly. `touched`
  // guards against silently enabling a proxy: an untouched default is NOT saved on blur, so users who
  // don't need a proxy still stay on direct-connect.
  const [value, setValue] = useState(termProxy || DEFAULT_PROXY)
  const [touched, setTouched] = useState(!!termProxy)
  const [saved, setSaved] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setValue(termProxy || DEFAULT_PROXY)
    setTouched(!!termProxy)
  }, [termProxy])

  const flashSaved = () => {
    setSaved(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setSaved(false), 1400)
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const commit = (v: string) => {
    setValue(v)
    setTouched(true)
    if (v !== termProxy) { onChange(v); flashSaved() }
  }

  return (
    <div className="set-group">
      <h4>终端代理</h4>
      <p className="set-desc">编码代理的命令行与网络请求将通过此代理转发。支持 http:// 与 socks5://(Shadowsocks 等)。留空则直连。</p>
      <div className="proj-field" style={{ marginTop: 14 }}>
        <label htmlFor="termProxy">代理地址</label>
        <input
          id="termProxy"
          type="text"
          placeholder={DEFAULT_PROXY}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          value={value}
          onChange={e => { setValue(e.target.value); setTouched(true) }}
          onBlur={() => {
            // Untouched prefilled default → treat as "not set", don't persist a proxy the user never chose.
            if (!touched && !termProxy) return
            if (value !== termProxy) { onChange(value); flashSaved() }
          }}
        />
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
        <span className={`proxy-status${saved ? ' saved' : ''}`}>
          <span className="dot" />
          已保存
        </span>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => { setValue(''); setTouched(true); onChange(''); flashSaved() }}
        >
          清空 · 直连
        </button>
      </div>
    </div>
  )
}
