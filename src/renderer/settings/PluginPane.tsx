import { useEffect, useState } from 'react'
import type { PluginsApi } from '../state/usePlugins'
import type { CatalogEntry } from '@shared/plugins'
import { isFeaturePlugin } from '@shared/plugins'
import { fmtRelTime } from '@shared/relTime'

const TYPE_LABELS: Record<string, string> = {
  'statusbar-usage': '状态栏额度显示',
  'pet-market': '功能 · 宠物市场',
}
function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type
}

// 退避剩余时长,给人看的粗粒度即可(「约 12 分钟后重试」)。
function fmtCooldown(ms: number): string {
  const mins = Math.ceil(ms / 60000)
  if (mins <= 1) return '约 1 分钟后重试'
  if (mins < 60) return `约 ${mins} 分钟后重试`
  return `约 ${Math.ceil(mins / 60)} 小时后重试`
}

// Per-provider guidance for the manual credential field. Claude/Codex/Gemini are auto-read from the
// local keychain/files; Cursor works with a pasted cookie; Qoder can ONLY be supplied manually.
const CRED_HINT: Record<string, string> = {
  claude: '通常自动从钥匙串读取，无需填写；如读取失败可粘贴 access token 覆盖。',
  codex: '通常自动从 ~/.codex/auth.json 读取，无需填写；如失败可粘贴 access token 覆盖。',
  gemini: '通常自动从 ~/.gemini 读取，无需填写；如失败可粘贴 access token 覆盖。',
  cursor: '粘贴 Cursor 的 WorkosCursorSessionToken cookie 即可读取额度。',
  qoder: 'Qoder 凭据已加密无法自动读取，需手动粘贴 token。',
}

function PluginIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h3a2 2 0 0 0 2-2 2 2 0 0 1 4 0 2 2 0 0 0 2 2h3v3a2 2 0 0 1-2 2 2 2 0 0 0 0 4 2 2 0 0 1 2 2v3h-3a2 2 0 0 0-2-2 2 2 0 0 1-4 0 2 2 0 0 0-2 2H4v-3a2 2 0 0 1 2-2 2 2 0 0 0 0-4 2 2 0 0 1-2-2z"/>
    </svg>
  )
}

type Tab = 'installed' | 'marketplace'

export function PluginPane({ plugins, results, catalog, loadCatalog, install, uninstall, setEnabled, refresh, installExample, installError, creds, setCred }: Omit<PluginsApi, 'usageByProvider'>) {
  const [tab, setTab] = useState<Tab>('installed')
  const [credOpen, setCredOpen] = useState<Record<string, boolean>>({})
  const [credDraft, setCredDraft] = useState<Record<string, string>>({})
  const [credSaved, setCredSaved] = useState<Record<string, boolean>>({})
  // ★ 目录只在切到「广场」页签时拉。这一次调用会去打 Cloudflare Worker 的「下架名单」端点,原先挂在
  // usePlugins 的 mount 上(每次启动 app 都打)、还跟着 pluginsChanged 广播走(pluginScheduler 每个周期
  // 都广播 → 开着 app 就每分钟一次)。用户明确要求「不打开广场就不许请求」,所以触发点收到这里。
  // plugins.length 进依赖:装/卸之后目录里的「已安装」标记要跟着变;它是个数字,调度器每个周期重建
  // plugins 数组并不会让它变化,所以不会退回到「每分钟一拉」。
  useEffect(() => { if (tab === 'marketplace') loadCatalog() }, [tab, plugins.length, loadCatalog])
  const now = Date.now()
  const draftFor = (provider: string) => credDraft[provider] ?? creds[provider] ?? ''
  const saveCred = async (provider: string) => {
    await setCred(provider, draftFor(provider))
    setCredSaved(s => ({ ...s, [provider]: true }))
    setTimeout(() => setCredSaved(s => ({ ...s, [provider]: false })), 1500)
  }

  return (
    <div className="set-group">
      <div className="plugin-head">
        <div>
          <h4>插件管理</h4>
          <p className="set-desc">安装、卸载和检查外部插件状态。插件是一个目录:含 manifest.json(id/name/type/provider/entry/refreshSec)与一个可执行入口,运行时向 stdout 打印 JSON,被 Forge 按类型挂到对应扩展点。</p>
        </div>
        <button className="plugin-upload" onClick={() => void install()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          上传插件
        </button>
      </div>

      {/* Tabs */}
      <div className="plugin-tabs">
        <button className={`plugin-tab${tab === 'installed' ? ' on' : ''}`} onClick={() => setTab('installed')}>已安装</button>
        <button className={`plugin-tab${tab === 'marketplace' ? ' on' : ''}`} onClick={() => setTab('marketplace')}>插件广场</button>
      </div>

      {installError && <div className="plugin-install-err">{installError}</div>}

      {tab === 'installed' ? (
        plugins.length === 0 ? (
          <div className="plugin-empty">
            暂无已安装插件。可点上方「插件广场」一键安装内置示例,或「上传插件」选择本地目录。
          </div>
        ) : (
          <div className="plugin-list">
            {plugins.map(p => {
              // 功能插件(宠物市场)不进调度、永远没有运行结果 —— 它的状态就是「开/关」本身。
              // 别把它当数据插件显示「未运行」(更别说以前那条「不支持的类型」红字)。
              const feature = isFeaturePlugin(p)
              const r = results[p.id]
              const hasResult = !feature && !!r
              const statusOn = feature ? p.enabled : hasResult && r.ok
              const statusErr = hasResult && !r.ok
              const statusText = feature
                ? (p.enabled ? '已启用' : '已停用')
                : !hasResult ? '未运行' : r.ok ? fmtRelTime(r.at, now) : (r.error ?? '错误')
              // 失败退避后下次自动重试可能在很久以后(429 尤其)。不说清楚,用户只会看到一条不动的错误,
              // 以为插件彻底坏了。这里把等待时长摆出来 —— 想立刻重试就点旁边的「刷新」(它绕过退避)。
              const cooldown = !feature && hasResult && !r.ok && r.nextAt && r.nextAt > now
                ? fmtCooldown(r.nextAt - now)
                : ''
              const statusCls = ['plugin-status', statusOn ? 'on' : '', statusErr ? 'err' : ''].filter(Boolean).join(' ')
              const canCred = p.type === 'statusbar-usage' && !!p.provider
              const provider = p.provider ?? ''
              const open = canCred && !!credOpen[p.id]
              return (
                <div className={`plugin-row${p.enabled ? '' : ' off'}`} key={p.id}>
                  <div className="plugin-ic"><PluginIcon /></div>
                  <div className="plugin-rmeta">
                    <div className="t">{p.name}</div>
                    <div className="d"><span>{typeLabel(p.type)}</span>{` · ${p.type}`}{p.provider ? ` · ${p.provider}` : ''}{feature ? '' : ` · 每 ${p.refreshSec}s`}</div>
                  </div>
                  <span className={statusCls} title={cooldown || undefined}>
                    {statusText}{cooldown ? ` · ${cooldown}` : ''}
                  </span>
                  <div className="plugin-row-actions">
                    {canCred && (
                      <button className={`plugin-action${creds[provider] ? ' primary' : ''}`} onClick={() => setCredOpen(s => ({ ...s, [p.id]: !s[p.id] }))} title="设置该插件的凭据(token/cookie)">
                        凭据{creds[provider] ? ' ✓' : ''}
                      </button>
                    )}
                    <button className={`plugin-action${!p.enabled ? ' primary' : ''}`} onClick={() => void setEnabled(p.id, !p.enabled)}>
                      {p.enabled ? '禁用' : '启用'}
                    </button>
                    {!feature && <button className="plugin-action" onClick={() => void refresh(p.id)}>刷新</button>}
                    <button className="plugin-action danger" onClick={() => void uninstall(p.id)}>卸载</button>
                  </div>
                  {open && (
                    <div className="plugin-cred">
                      <div className="plugin-cred-hint">{CRED_HINT[provider] ?? '粘贴该服务的 token/cookie 以读取额度。'}</div>
                      <div className="plugin-cred-row">
                        <input
                          type="password"
                          className="plugin-cred-input"
                          placeholder="粘贴 token / cookie(留空=清除，恢复自动读取)"
                          value={draftFor(provider)}
                          onChange={e => setCredDraft(d => ({ ...d, [provider]: e.target.value }))}
                        />
                        <button className="plugin-action primary" onClick={() => void saveCred(provider)}>
                          {credSaved[provider] ? '已保存' : '保存'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      ) : (
        catalog.length === 0 ? (
          <div className="plugin-empty">暂无可安装的内置插件。</div>
        ) : (
          <div className="plugin-list">
            {catalog.map((c: CatalogEntry) => (
              <div className={`plugin-row${c.available ? '' : ' off'}`} key={c.id}>
                <div className="plugin-ic"><PluginIcon /></div>
                <div className="plugin-rmeta">
                  <div className="t">{c.name}</div>
                  <div className="d">{c.description}</div>
                </div>
                <div className="plugin-meta">
                  <span>{c.type}</span>
                  {c.provider && <span>{c.provider}</span>}
                </div>
                <div className="plugin-row-actions">
                  {c.installed ? (
                    <span className="plugin-installed">已安装</span>
                  ) : (
                    <button
                      className="plugin-action primary"
                      disabled={!c.available}
                      onClick={() => void installExample(c.id)}
                    >
                      安装
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}
