// 插件详情(08 §13.3):plugins.get → 授权(同一个编辑器,plugins.grants.set)、配置、服务状态、
// 升级(ref 可填,走同一个同意页,带 diff)、禁用 / 启用、卸载(确认框带 保留 一行,09 §13)。
// 启用成功后由页面决定显示 新会话(09 §15:插件视图钉在会话的第一轮,要新开会话才看得到)。
// 08b:头(标志、id、版本、格式、状态、来源、动作)+ 页签 授权 / 配置 / 服务 N / 内容。页签只是跳转锚点(R22):
// 各分区和今天一样随详情一起挂着,点页签只 scrollIntoView。升级暂存时和今天一样只留头,同意在 UpgradeModal 里;
// 暂存开着时头里的 升级 和 ref 不可用(再点会换暂存)。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Grants as GrantsT, PluginDetail as Detail, PluginIdPayload, PluginListResult } from '@mffai/protocol'
import { call, isUnsupported, retryable } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { route } from '../route'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { Icon } from '../shell/icons'
import { Confirm } from '../ui/Confirm'
import { PText } from '../ui/PText'
import { Grants, initialGrants } from './Grants'
import { Settings } from './Settings'
import { McpStateCell, McpTable } from './McpTable'
import { Staging } from './Install'
import { UpgradeModal } from './UpgradeModal'
import { FailChip, useAction } from './action'

type Row = PluginListResult['plugins'][number]

const sourceText = (s: Row['source']) => (s.kind === 'path' ? s.path : `${s.url}@${s.commit}`)
type Sec = 'grants' | 'settings' | 'servers' | 'content'

export const KEEP_ON_UNINSTALL = '事件日志里已发生的调用记录'

export function PluginDetail({ plugin, showNewSession, onEnabled, onClose }: {
  plugin: Row
  showNewSession: boolean
  onEnabled: (id: string, enabled: boolean) => void
  onClose: () => void
}) {
  const { id } = plugin
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loadFailed, setLoadFailed] = useState<'unsupported' | 'failed' | null>(null)
  const [draft, setDraft] = useState<GrantsT | null>(null)
  const dirty = useRef(false)
  const [upRef, setUpRef] = useState('')
  const [staging, setStaging] = useState<string | null>(null)
  const [uninstalling, setUninstalling] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const grantsCmd = useRef(retryable()).current
  const enableCmd = useRef(retryable()).current
  const uninstallCmd = useRef(retryable()).current
  const grantsAct = useAction()
  const enableAct = useAction()
  const uninstallAct = useAction()
  const upgradeAct = useAction()

  const load = useCallback(() => {
    void call('plugins.get', { id }).then(
      (d) => {
        if (!alive.current) return
        setDetail(d)
        setLoadFailed(null)
        if (!dirty.current) setDraft(initialGrants(d.consent.mcp, d.grants))
      },
      (e) => { if (alive.current) setLoadFailed(isUnsupported(e) ? 'unsupported' : 'failed') },
    )
  }, [id])
  useEffect(load, [load])
  useMffaiReset(load)
  useMffaiEvent({ types: ['plugins.grants.updated', 'plugins.upgraded', 'plugins.enabled', 'plugins.disabled', 'plugins.integrity.failed', 'plugins.mcp.status', 'plugins.uninstalled'] }, (e) => {
    const p = e.payload as Partial<PluginIdPayload> & { plugin?: string }
    if ((p.id ?? p.plugin) !== id) return
    if (e.type === 'plugins.uninstalled') { onClose(); return }
    load()
  })

  const saveGrants = () => void grantsAct.run('plugins.grants.set', async () => {
    if (!draft) return
    const key = JSON.stringify(draft)
    await call('plugins.grants.set', { commandId: grantsCmd.id(key), id, grants: draft })
    grantsCmd.done(key)
    dirty.current = false
    load()
  })
  const setEnabled = (enabled: boolean) => void enableAct.run('plugins.setEnabled', async () => {
    const key = String(enabled)
    await call('plugins.setEnabled', { commandId: enableCmd.id(key), id, enabled })
    enableCmd.done(key)
    onEnabled(id, enabled)
  })
  const uninstall = () => void uninstallAct.run('plugins.uninstall', async () => {
    await call('plugins.uninstall', { commandId: uninstallCmd.id(id), id })
    uninstallCmd.done(id)
    onClose()
  })
  const upgrade = () => void upgradeAct.run('plugins.upgrade.prepare', async () => {
    const ref = upRef.trim()
    const r = await call('plugins.upgrade.prepare', { id, ...(ref && { ref }) })
    if (upgradeAct.alive.current) setStaging(r.stagingId)
  })

  const head = (
    <div className="mffai-dhead">
      <span className="mffai-plogo lg"><Icon name="puzzle" size={18} /></span>
      <div className="mffai-did">
        <div className="mffai-dname">
          <PText text={id} />
          <PText text={plugin.version} mono />
          <CodeChip code={plugin.format} />
          <Chip tone={plugin.enabled ? 'ok' : 'muted'} dot={plugin.enabled}>{plugin.enabled ? '已启用' : '已停用'}</Chip>
          {plugin.problems.map((c) => <CodeChip key={c} code={c} />)}
        </div>
        <div className="mffai-dsrc"><PText text={sourceText(plugin.source)} mono /></div>
      </div>
      <div className="mffai-dact">
        {showNewSession && plugin.enabled && <button className="set-btn mffai-primary" onClick={() => route.set({ page: 'chat', newSession: {} })}><Icon name="chat" size={13} />新会话</button>}
        <span className="mffai-dup">
          <input aria-label="升级 ref" placeholder="ref" value={upRef} disabled={staging !== null} onChange={(e) => setUpRef(e.target.value)} />
          <button className="set-btn" disabled={upgradeAct.busy || !detail || staging !== null} onClick={upgrade}><Icon name="up" size={13} />升级</button>
        </span>
        <FailChip failure={upgradeAct.failure} />
        <button className="set-btn" disabled={enableAct.busy} onClick={() => setEnabled(!plugin.enabled)}>{plugin.enabled ? '禁用' : '启用'}</button>
        <FailChip failure={enableAct.failure} />
        <button className="set-btn mffai-danger" onClick={() => setUninstalling(true)}><Icon name="trash" size={13} />卸载</button>
        <button className="mffai-iconbtn" onClick={onClose}><Icon name="x" size={14} /><span className="mffai-sr">关闭</span></button>
      </div>
    </div>
  )
  const secs = useRef<Partial<Record<Sec, HTMLElement | null>>>({})
  const jump = (s: Sec) => secs.current[s]?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  const secRef = (s: Sec) => (el: HTMLElement | null) => { secs.current[s] = el }

  if (staging) {
    return (
      <div className="mffai-group mffai-detail" data-detail={id}>
        {head}
        {/* 升级同意在弹窗里(B)。key:每次暂存一个新的 Staging,旧暂存的状态、consentHash、授权不会带到新暂存上 */}
        <UpgradeModal onClose={() => setStaging(null)}>
          <Staging key={staging} stagingId={staging} current={detail!.grants} onClose={() => setStaging(null)}
            onInstalled={(pid, enabled) => { setStaging(null); onEnabled(pid, enabled); load() }} />
        </UpgradeModal>
      </div>
    )
  }

  const c = detail?.consent
  return (
    <div className="mffai-group mffai-detail" data-detail={id}>
      {head}
      <nav className="mffai-tabs mffai-dtabs" aria-label="分区">
        <button className="set-btn" onClick={() => jump('grants')}>授权</button>
        <button className="set-btn" onClick={() => jump('settings')}>配置</button>
        <button className="set-btn" onClick={() => jump('servers')}>服务 <span className="mffai-tabn">{detail?.servers.length ?? 0}</span></button>
        <button className="set-btn" onClick={() => jump('content')}>内容</button>
      </nav>
      {loadFailed === 'unsupported' && <Chip tone="bad">不支持</Chip>}
      {loadFailed === 'failed' && <span className="mffai-fail">失败</span>}
      <div className="mffai-dbody">
        <div className="mffai-dcol">
          <section className="mffai-dsec" data-dsec="grants" ref={secRef('grants')}>
            <div className="mffai-sech">
              <span>每个服务的授权</span>
              <span className="mffai-head-spring" />
              <FailChip failure={grantsAct.failure} />
              {detail && draft && detail.consent.mcp.length > 0 && (
                <button className="set-btn mffai-primary" disabled={grantsAct.busy} onClick={saveGrants}>保存授权</button>
              )}
            </div>
            {detail && draft && (
              <Grants mcp={detail.consent.mcp} value={draft} disabled={grantsAct.busy} onChange={(g) => { dirty.current = true; setDraft(g) }} />
            )}
          </section>
        </div>
        <div className="mffai-dcol">
          <section className="mffai-dsec" data-dsec="settings" ref={secRef('settings')}>
            <div className="mffai-sech"><span>配置</span></div>
            {detail && draft && <Settings id={id} config={detail.consent.config} settings={detail.settings} onChanged={load} />}
          </section>
          <section className="mffai-dsec" data-dsec="servers" ref={secRef('servers')}>
            <div className="mffai-sech"><span>服务</span></div>
            {detail && draft && detail.servers.length > 0 && (
              <div className="mffai-group mffai-dcard" data-section="servers">
                {detail.servers.map((s) => (
                  <div key={s.name} className="mffai-row" data-server-state={s.name}>
                    <PText text={s.name} mono />
                    <span className="mffai-head-spring" />
                    <McpStateCell state={s.state} reason={s.reason} />
                  </div>
                ))}
                <McpTable plugin={id} compact />
              </div>
            )}
          </section>
          <section className="mffai-dsec" data-dsec="content" ref={secRef('content')}>
            <div className="mffai-sech"><span>内容</span></div>
            {c && (
              <div className="mffai-dcard mffai-dcontent">
                <div className="mffai-row"><span className="mffai-k">integrity</span><PText text={c.integrity} mono /></div>
                <div className="mffai-row"><span className="mffai-k">文件</span><span className="mffai-count">{c.files}</span><span className="mffai-k">bytes</span><span className="mffai-count">{c.bytes}</span></div>
                {c.skills.length > 0 && (
                  <div className="mffai-row mffai-crow"><span className="mffai-k">技能</span>{c.skills.map((k, i) => <PText key={i} text={k.name} mono />)}</div>
                )}
                {c.commands.length > 0 && (
                  <div className="mffai-row mffai-crow"><span className="mffai-k">命令</span>{c.commands.map((k, i) => <PText key={i} text={k.name} mono />)}</div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
      {uninstalling && (
        <Confirm title="卸载插件" rows={[
          ['插件', <PText key="id" text={id} mono />], ['版本', <PText key="v" text={plugin.version} mono />],
          ['删除', '插件代码'], ['删除', 'plugin-data'], ['删除', '插件的凭据'],
        ]}
          keep={[KEEP_ON_UNINSTALL]} confirmLabel="卸载" danger busy={uninstallAct.busy}
          onCancel={() => setUninstalling(false)} onConfirm={uninstall}>
          <FailChip failure={uninstallAct.failure} />
        </Confirm>
      )}
    </div>
  )
}
