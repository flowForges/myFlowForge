// 安装(08 §13.2):两个页签 本地路径 / git → plugins.install.prepare → stagingId → Staging。
// Staging(安装和升级共用):听 plugins.install.state、fetching 时每秒轮询 install.status;failed 显示代码和违规的相对路径;
// ready → 同意页 + 授权 + 安装 / 安装并启用 / 取消。确认带 consentHash 和每个服务的授权。
// 没确认就离开(取消、关掉、换页)时取消暂存:暂存同时最多 3 个,留着会挡住下一次安装。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Grants as GrantsT, PluginInstallStatus, PluginSourceParam, PluginsInstallStatePayload } from '@mffai/protocol'
import { call, retryable } from '../rpc'
import { useMffaiEvent } from '../events'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { PathField } from '../ui/PathField'
import { PText } from '../ui/PText'
import { Consent } from './Consent'
import { Grants, initialGrants, upgradeGrants } from './Grants'
import { FailChip, failureOf, useAction, type Failure } from './action'

const POLL_MS = 1000

export function Staging({ stagingId, current, onClose, onInstalled }: {
  stagingId: string
  /** 升级:当前的授权。起点是它和新声明的交集(后台对发来的服务整份替换,不能从默认开始) */
  current?: GrantsT
  onClose: () => void
  onInstalled: (id: string, enabled: boolean) => void
}) {
  const [st, setSt] = useState<PluginInstallStatus | null>(null)
  const [statusFailure, setStatusFailure] = useState<Failure | null>(null)
  const [grants, setGrants] = useState<GrantsT | null>(null)
  const { run, busy, failure, alive } = useAction()
  const retry = useRef(retryable()).current
  /** 确认了或取消了:卸载时不再取消 */
  const settled = useRef(false)

  const currentRef = useRef(current)
  currentRef.current = current
  const fetchStatus = useCallback(() => {
    void call('plugins.install.status', { stagingId }).then(
      (s) => {
        if (!alive.current) return
        setSt(s)
        setStatusFailure(null)
        if (s.state === 'ready' && s.consent) {
          const mcp = s.consent.mcp
          const cur = currentRef.current
          setGrants((g) => g ?? (cur ? upgradeGrants(mcp, cur) : initialGrants(mcp)))
        }
      },
      (e) => { if (alive.current) setStatusFailure(failureOf('plugins.install.status', e)) },
    )
  }, [stagingId, alive])

  useEffect(fetchStatus, [fetchStatus])
  const fetching = !st || st.state === 'fetching'
  useEffect(() => {
    if (!fetching || statusFailure) return
    const t = setInterval(fetchStatus, POLL_MS)
    return () => clearInterval(t)
  }, [fetching, statusFailure, fetchStatus])
  useMffaiEvent({ types: ['plugins.install.state'] }, (e) => {
    if ((e.payload as PluginsInstallStatePayload)?.stagingId === stagingId) fetchStatus()
  })
  useEffect(() => () => {
    if (settled.current) return
    void call('plugins.install.cancel', { stagingId }).catch(() => {})
  }, [stagingId])

  const cancel = () => void run('plugins.install.cancel', async () => {
    settled.current = true
    try {
      await call('plugins.install.cancel', { stagingId })
    } catch (e) {
      // 已经过期、已经失败的暂存取消不了,也不用取消
      failureOf('plugins.install.cancel', e)
    }
    onClose()
  })

  const confirm = (enable: boolean) => void run('plugins.install.confirm', async () => {
    if (!st?.consentHash || !grants) return
    const key = `${enable}|${JSON.stringify(grants)}`
    const r = await call('plugins.install.confirm', { commandId: retry.id(key), stagingId, consentHash: st.consentHash, grants, enable })
    if (!r.ok) throw new Error('not ok')
    retry.done(key)
    settled.current = true
    onInstalled(r.id, enable)
  })

  const ready = st?.state === 'ready' && st.consent && st.consentHash && grants
  return (
    <div className="mffai-staging" data-staging={stagingId}>
      {fetching && !statusFailure && <div className="mffai-row"><Chip tone="warn">读取中</Chip></div>}
      {statusFailure && <div className="mffai-row"><FailChip failure={statusFailure} /></div>}
      {st?.state === 'failed' && (
        <div className="mffai-row">
          <Chip tone="bad">读取失败</Chip>
          {st.error && <CodeChip code={st.error} />}
          {st.path && <PText text={st.path} mono />}
        </div>
      )}
      {ready && (
        <>
          <Consent consent={st.consent!} />
          <Grants mcp={st.consent!.mcp} value={grants} onChange={setGrants} disabled={busy} />
        </>
      )}
      <div className="mffai-actions">
        {ready && <button className="set-btn" disabled={busy} onClick={() => confirm(false)}>安装</button>}
        {ready && <button className="set-btn mffai-primary" disabled={busy} onClick={() => confirm(true)}>安装并启用</button>}
        <button className="set-btn" disabled={busy} onClick={cancel}>取消</button>
        <FailChip failure={failure} />
      </div>
    </div>
  )
}

type Tab = 'path' | 'git'

export function Install({ onClose, onInstalled }: { onClose: () => void; onInstalled: (id: string, enabled: boolean) => void }) {
  const [tab, setTab] = useState<Tab>('path')
  const [path, setPath] = useState('')
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [subpath, setSubpath] = useState('')
  const [stagingId, setStagingId] = useState<string | null>(null)
  const { run, busy, failure, alive } = useAction()

  const source = (): PluginSourceParam | null => {
    if (tab === 'path') return path.trim() ? { kind: 'path', path: path.trim() } : null
    if (!url.trim()) return null
    return { kind: 'git', url: url.trim(), ...(ref.trim() && { ref: ref.trim() }), ...(subpath.trim() && { subpath: subpath.trim() }) }
  }
  const prepare = () => void run('plugins.install.prepare', async () => {
    const s = source()
    if (!s) return
    const r = await call('plugins.install.prepare', { source: s })
    if (alive.current) setStagingId(r.stagingId)
  })

  if (stagingId) return <Staging stagingId={stagingId} onClose={onClose} onInstalled={onInstalled} />
  return (
    <div className="mffai-group mffai-install">
      <div className="mffai-tabs" role="tablist">
        {([['path', '本地路径'], ['git', 'git']] as const).map(([id, name]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`set-btn${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>{name}</button>
        ))}
      </div>
      {tab === 'path'
        ? <div className="mffai-row"><PathField kind="directory" label="路径" value={path} onChange={setPath} /></div>
        : (
          <>
            <div className="mffai-row"><span className="mffai-k">地址</span><input aria-label="地址" value={url} onChange={(e) => setUrl(e.target.value)} /></div>
            <div className="mffai-row"><span className="mffai-k">ref</span><input aria-label="ref" value={ref} onChange={(e) => setRef(e.target.value)} /></div>
            <div className="mffai-row"><span className="mffai-k">子目录</span><input aria-label="子目录" value={subpath} onChange={(e) => setSubpath(e.target.value)} /></div>
          </>
        )}
      <div className="mffai-actions">
        <button className="set-btn mffai-primary" disabled={busy || !source()} onClick={prepare}>读取</button>
        <button className="set-btn" onClick={onClose}>取消</button>
        <FailChip failure={failure} />
      </div>
    </div>
  )
}
