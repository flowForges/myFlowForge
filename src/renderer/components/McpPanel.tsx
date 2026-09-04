import { useCallback, useEffect, useRef, useState } from 'react'
import { MCP_AUTH_LABEL, type McpLoginStarted, type McpProviderView, type McpServerView } from '@shared/mcp'
import './mcpPanel.css'

/**
 * MCP 面板:每个 provider 下配了哪些 MCP 服务器、连上没有、能不能授权。
 *
 * ★★用户原话:「provider 是否支持 /mcp 这个命令,咱们得支持,因为我发现我想 mcp 授权,授权不了」。
 *  `/mcp` 是 claude **交互式界面**里的一屏,我们跑的是非交互模式,那一屏不存在 —— 所以这里调的是
 *  各 CLI 自己的 `mcp` 子命令(见 `main/agents/mcpCli.ts`)。入口保留 `/mcp` 这个打法,因为那是
 *  用户脑子里的名字。
 *
 * ★授权那一步的分工是这个面板最要紧的一件事:
 *   · `mcp login` 跑在**主机**上(凭据也落在那儿);
 *   · 授权链接用 `openExternal` 打开 —— 那条是 CLIENT_ONLY,永远在**你正看着的这台**上开;
 *   · 浏览器最后会跳到一个 `http://localhost:<port>/callback…`,如果你就在主机上,CLI 自己就收到了,
 *     什么都不用做;如果你在另一台机器 / 手机上,那一页打不开,把地址栏整条粘回来即可。
 *  界面上把这两种情况**同时**摆出来,而不是猜你是哪种。
 */
export function McpPanel({ workspacePath, onClose }: { workspacePath?: string; onClose: () => void }) {
  return (
    <div className="imp-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="imp-sheet mcp-sheet">
        <McpList workspacePath={workspacePath} onClose={onClose} />
      </div>
    </div>
  )
}

/**
 * 面板正文。★单独拆出来是因为它有**两个**入口:聊天里 `/mcp` 弹出来的那个弹层,
 * 和设置里的「MCP」那一页 —— 两处必须是同一份东西,抄两份迟早各改各的。
 */
export function McpList({ workspacePath, onClose }: { workspacePath?: string; onClose?: () => void }) {
  const [rows, setRows] = useState<McpProviderView[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    setErr(null)
    try {
      setRows(await window.forge.mcpOverview(workspacePath))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [workspacePath])

  useEffect(() => { void load() }, [load])

  const usable = (rows ?? []).filter(r => r.caps.mcp)
  const noMcp = (rows ?? []).filter(r => !r.caps.mcp)

  return (
    <>
        <div className="imp-head">
          <div className="imp-mark">🔌</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>MCP 服务器</h2>
            <div className="d">
              这台主机上各 CLI 自己配的 MCP。授权跑在主机上，链接在你正看着的这台设备上打开。
            </div>
          </div>
          <button className="imp-tool" onClick={() => void load()} disabled={busy}>{busy ? '读取中…' : '刷新'}</button>
          {/* 设置里那一页没有"关闭"这回事(它就是一页),所以这颗键只在弹层里出现。 */}
          {onClose && <button className="x" onClick={onClose} aria-label="关闭">✕</button>}
        </div>

        <div className="imp-body">
          {err && <div className="imp-note err">{err}</div>}
          {rows === null && !err && <div className="imp-note">正在问各个 CLI…</div>}

          {usable.map(r => (
            <ProviderBlock key={r.providerId} row={r} workspacePath={workspacePath} onChanged={() => void load()} />
          ))}

          {rows !== null && usable.length === 0 && !err && (
            <div className="imp-note">
              这台主机上装着的 CLI 都没有 <b>mcp</b> 子命令。MCP 服务器要先在 CLI 那边配好（<b>claude mcp add</b> / <b>codex mcp add</b>），这里才看得到。
            </div>
          )}

          {/* ★没有 mcp 的那些**也列出来并说明原因** —— 决策 B-2:一个说明了原因的灰条,
              好过一个什么都不显示的空面板(那看着像功能坏了)。 */}
          {noMcp.length > 0 && (
            <div className="mcp-nomcp">
              {noMcp.map(r => (
                <div key={r.providerId}>
                  <b>{r.displayName}</b> 这个版本没有 mcp 子命令{r.error ? `（${r.error}）` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
    </>
  )
}

function ProviderBlock({ row, workspacePath, onChanged }: { row: McpProviderView; workspacePath?: string; onChanged: () => void }) {
  return (
    <div className="mcp-block">
      <div className="imp-sub">
        <h5>{row.displayName}</h5>
        <span className="mcp-caps">
          {row.caps.login ? '可授权' : '只读'}
          {row.caps.noBrowser ? ' · 可跨设备' : ''}
        </span>
      </div>
      {row.error && <div className="imp-note err">{row.error}</div>}
      {!row.error && row.servers.length === 0 && <div className="imp-note">还没配 MCP 服务器。</div>}
      {row.servers.map(s => (
        <ServerRow key={s.name} providerId={row.providerId} canLogin={row.caps.login} canLogout={row.caps.logout}
          server={s} workspacePath={workspacePath} onChanged={onChanged} />
      ))}
    </div>
  )
}

function ServerRow({
  providerId, server, canLogin, canLogout, workspacePath, onChanged,
}: {
  providerId: string
  server: McpServerView
  canLogin: boolean
  canLogout: boolean
  workspacePath?: string
  onChanged: () => void
}) {
  const [login, setLogin] = useState<McpLoginStarted | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [redirect, setRedirect] = useState('')
  // 起了 login 就必须收尾:组件被卸载(关面板 / 切走)时把那个进程杀掉,
  // 否则 `mcp login` 会一直挂在主机上等回调 —— 一个看不见的常驻孤儿。
  const liveId = useRef<string | null>(null)
  useEffect(() => () => { if (liveId.current) void window.forge.mcpLoginCancel(liveId.current) }, [])

  const start = async () => {
    setBusy(true); setMsg(null); setRedirect('')
    try {
      const r = await window.forge.mcpLoginStart({ providerId, workspacePath, name: server.name })
      liveId.current = r.outcome ? null : r.id
      setLogin(r)
      if (r.outcome === 'ok') { finish('授权成功'); return }
      if (r.outcome === 'fail') { setMsg(r.text.trim() || '授权没成'); setLogin(null); return }
      // 链接在**这台设备**上打开(CLIENT_ONLY);同时后台等 localhost 回调 ——
      // 你要是就在主机上,这一步会自己完成,不用粘任何东西。
      if (r.url) void window.forge.openExternal(r.url)
      void window.forge.mcpLoginWait({ id: r.id }).then((w) => {
        if (liveId.current !== r.id) return
        if (w.outcome === 'ok') finish('授权成功')
        else if (w.outcome === 'fail') { setMsg(w.text.trim() || '授权没成'); setLogin(null); liveId.current = null }
      })
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const finish = (m: string) => {
    liveId.current = null
    setLogin(null)
    setMsg(m)
    onChanged()
  }

  const paste = async () => {
    if (!login || !redirect.trim()) return
    setBusy(true)
    try {
      const r = await window.forge.mcpLoginPaste({ id: login.id, redirectUrl: redirect })
      if (r.outcome === 'ok') finish('授权成功')
      else { setMsg(r.text.trim() || '授权没成'); setLogin(null); liveId.current = null }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const cancel = () => {
    if (login) void window.forge.mcpLoginCancel(login.id)
    liveId.current = null
    setLogin(null)
    setMsg('已取消')
  }

  const logout = async () => {
    setBusy(true); setMsg(null)
    try {
      await window.forge.mcpLogout({ providerId, workspacePath, name: server.name })
      setMsg('已取消授权')
      onChanged()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const needsAuth = server.auth === 'needs-auth' || server.auth === 'failed' || server.auth === 'unknown'
  return (
    <div className="mcp-row">
      <div className="mcp-row-h">
        <span className={`mcp-dot ${server.auth}`} />
        <span className="mcp-name">{server.name}</span>
        <span className={`mcp-state ${server.auth}`} title={server.detail}>{MCP_AUTH_LABEL[server.auth]}</span>
        <span className="mcp-target" title={server.target}>{server.target}</span>
        <span style={{ flex: 1 }} />
        {canLogin && needsAuth && <button className="imp-tool" onClick={() => void start()} disabled={busy || !!login}>授权</button>}
        {canLogout && server.auth === 'connected' && <button className="imp-tool" onClick={() => void logout()} disabled={busy}>取消授权</button>}
      </div>

      {login && (
        <div className="mcp-login">
          {login.url ? (
            <>
              <div className="mcp-step">
                已在这台设备上打开授权页。<b>如果没弹出来</b>，复制这条地址自己打开：
              </div>
              <div className="mcp-url">
                <code>{login.url}</code>
                <button className="imp-tool" onClick={() => void navigator.clipboard?.writeText(login.url!)}>复制</button>
              </div>
              {/* ★这一段永远摆着,不猜你在哪台设备上:
                  在主机上授权 → 回调自己完成,这个框用不上;
                  在别的设备(手机)上授权 → 最后那一页打不开,把地址栏整条粘进来。 */}
              <div className="mcp-step">
                授权完如果浏览器停在一个打不开的 <b>localhost</b> 页面，把地址栏里那条整个粘到这里：
              </div>
              <div className="mcp-paste">
                <input
                  value={redirect}
                  onChange={e => setRedirect(e.target.value)}
                  placeholder="http://localhost:3118/callback?code=…"
                  spellCheck={false}
                />
                <button className="imp-tool" onClick={() => void paste()} disabled={busy || !redirect.trim()}>提交</button>
                <button className="imp-tool" onClick={cancel}>取消</button>
              </div>
            </>
          ) : (
            <>
              <div className="mcp-step">
                这个 CLI 不打印授权链接，它会在<b>主机那台机器</b>上直接开浏览器。连着远程主机时你看不到那个窗口。
              </div>
              <div className="mcp-paste"><button className="imp-tool" onClick={cancel}>取消</button></div>
            </>
          )}
        </div>
      )}

      {msg && <div className={`imp-note ${msg.includes('成功') ? 'ok' : msg === '已取消' || msg === '已取消授权' ? '' : 'err'}`}>{msg}</div>}
    </div>
  )
}
