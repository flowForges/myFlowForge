// 插件详情(08 §13.3):plugins.get → 授权(同一个编辑器,plugins.grants.set)、配置、服务状态、
// 升级(ref 可填,走同一个同意页,带 diff)、禁用 / 启用、卸载(确认框带 保留 一行,09 §13)。
// 启用成功后由页面决定显示 新会话(09 §15:插件视图钉在会话的第一轮,要新开会话才看得到)。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Grants as GrantsT, PluginDetail as Detail, PluginIdPayload, PluginListResult } from '@mffai/protocol'
import { call, isUnsupported, retryable } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { route } from '../route'
import { Chip } from '../ui/Chip'
import { Confirm } from '../ui/Confirm'
import { PText } from '../ui/PText'
import { Grants, initialGrants } from './Grants'
import { Settings } from './Settings'
import { McpStateCell, McpTable } from './McpTable'
import { Staging } from './Install'
import { FailChip, useAction } from './action'

type Row = PluginListResult['plugins'][number]

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
    <div className="mffai-row mffai-crow">
      <PText text={id} mono />
      <PText text={plugin.version} mono />
      <Chip tone={plugin.enabled ? 'ok' : 'muted'}>{plugin.enabled ? '已启用' : '已停用'}</Chip>
      <button className="set-btn" disabled={enableAct.busy} onClick={() => setEnabled(!plugin.enabled)}>{plugin.enabled ? '禁用' : '启用'}</button>
      {showNewSession && plugin.enabled && <button className="set-btn mffai-primary" onClick={() => route.set({ page: 'chat', newSession: {} })}>新会话</button>}
      <FailChip failure={enableAct.failure} />
      <button className="set-btn" onClick={() => setUninstalling(true)}>卸载</button>
      <button className="set-btn" onClick={onClose}>关闭</button>
    </div>
  )

  if (staging) {
    return (
      <div className="mffai-group mffai-detail" data-detail={id}>
        {head}
        <Staging stagingId={staging} onClose={() => setStaging(null)}
          onInstalled={(pid, enabled) => { setStaging(null); onEnabled(pid, enabled); load() }} />
      </div>
    )
  }

  return (
    <div className="mffai-group mffai-detail" data-detail={id}>
      {head}
      {loadFailed === 'unsupported' && <Chip tone="bad">不支持</Chip>}
      {loadFailed === 'failed' && <span className="mffai-fail">失败</span>}
      {detail && draft && (
        <>
          <Grants mcp={detail.consent.mcp} value={draft} disabled={grantsAct.busy} onChange={(g) => { dirty.current = true; setDraft(g) }} />
          {detail.consent.mcp.length > 0 && (
            <div className="mffai-actions">
              <button className="set-btn mffai-primary" disabled={grantsAct.busy} onClick={saveGrants}>保存授权</button>
              <FailChip failure={grantsAct.failure} />
            </div>
          )}
          <Settings id={id} config={detail.consent.config} settings={detail.settings} onChanged={load} />
          {detail.servers.length > 0 && (
            <div className="mffai-group" data-section="servers">
              <div className="mffai-grouphead"><span>服务状态</span></div>
              {detail.servers.map((s) => (
                <div key={s.name} className="mffai-row" data-server-state={s.name}>
                  <PText text={s.name} mono />
                  <McpStateCell state={s.state} reason={s.reason} />
                </div>
              ))}
              <McpTable plugin={id} />
            </div>
          )}
        </>
      )}
      <div className="mffai-row">
        <span className="mffai-k">ref</span>
        <input aria-label="升级 ref" value={upRef} onChange={(e) => setUpRef(e.target.value)} />
        <button className="set-btn" disabled={upgradeAct.busy} onClick={upgrade}>升级</button>
        <FailChip failure={upgradeAct.failure} />
      </div>
      {uninstalling && (
        <Confirm title="卸载插件" rows={[['插件', <PText key="id" text={id} mono />], ['版本', <PText key="v" text={plugin.version} mono />]]}
          keep={[KEEP_ON_UNINSTALL]} confirmLabel="卸载" danger busy={uninstallAct.busy}
          onCancel={() => setUninstalling(false)} onConfirm={uninstall}>
          <FailChip failure={uninstallAct.failure} />
        </Confirm>
      )}
    </div>
  )
}
