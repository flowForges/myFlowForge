// 安装(08 §13.2):两个页签 本地路径 / git → plugins.install.prepare → stagingId → Staging。
// Staging(安装和升级共用):听 plugins.install.state、fetching 时每秒轮询 install.status;failed 显示代码和违规的相对路径;
// ready → 同意页 + 授权 + 安装 / 安装并启用 / 取消。确认带 consentHash 和每个服务的授权。
// 没确认就离开(取消、关掉、换页)时取消暂存:暂存同时最多 3 个,留着会挡住下一次安装。
// 08b:添加面板 = 头(添加插件 + 关闭)、本地路径 / git 分段、字段、读取;读取之后表单留着(读取不可再点),
// 暂存在 获取记录 下面是一条带:读取中 / 失败(代码 + 路径)/ 就绪。就绪后首装是整页审阅(A,盖住插件页,
// 底栏 取消 / 安装 / 安装并启用);带 current 的是升级(B,在 UpgradeModal 里,底栏 取消 / 升级但停用 / 升级)。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Grants as GrantsT, PluginInstallStatus, PluginSourceParam, PluginsInstallStatePayload } from '@mffai/protocol'
import { call, retryable } from '../rpc'
import { useMffaiEvent } from '../events'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { PathField } from '../ui/PathField'
import { PText } from '../ui/PText'
import { Icon } from '../shell/icons'
import { Consent, CWD_LABEL } from './Consent'
import { diffMarks } from './ConsentSection'
import { useInertOutside } from './UpgradeModal'
import { Grants, initialGrants, upgradeGrants } from './Grants'
import { FailChip, failureOf, useAction, type Failure } from './action'

const POLL_MS = 1000

export function Staging({ stagingId, current, wasEnabled, onClose, onInstalled, onBusy }: {
  stagingId: string
  /** 升级:当前的授权。起点是它和新声明的交集(后台对发来的服务整份替换,不能从默认开始) */
  current?: GrantsT
  /** 升级:插件现在是停用的 → 主按钮写 升级并启用(照旧发 enable:true) */
  wasEnabled?: boolean
  onClose: () => void
  onInstalled: (id: string, enabled: boolean) => void
  /** 确认或取消在路上:升级弹窗这时不理 Esc(Esc 会卸载暂存、发取消,和确认抢) */
  onBusy?: (busy: boolean) => void
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
  const upgrade = current !== undefined
  const busyRef = useRef(onBusy)
  busyRef.current = onBusy
  useEffect(() => { busyRef.current?.(busy) }, [busy])
  // 首装整页盖住插件页:盖住的东西 inert,Tab 走不到
  const page = useRef<HTMLDivElement>(null)
  useInertOutside(page, Boolean(ready) && !upgrade)
  const servers = grants ? Object.values(grants.servers) : []
  const checkedHosts = servers.reduce((n, s) => n + s.network.length, 0)
  const cwdLevels = [...new Set(servers.map((s) => CWD_LABEL[s.cwd]))].join(' / ')
  const totals = st?.consent?.diff ? Object.values(diffMarks(st.consent.diff)) : []
  const sum = (k: 'add' | 'mod' | 'del') => totals.reduce((n, m) => n + (m[k] ?? 0), 0)
  const close = <button className="mffai-iconbtn" disabled={busy} onClick={cancel}><Icon name="x" size={14} /><span className="mffai-sr">关闭</span></button>
  const grantsEditor = ready ? <Grants mcp={st.consent!.mcp} value={grants} onChange={setGrants} disabled={busy} /> : null
  return (
    <div className={`mffai-staging${upgrade ? ' mffai-ustaging' : ''}`} data-staging={stagingId}>
      {fetching && !statusFailure && <div className="mffai-row mffai-fetch run"><span className="mffai-spin" /><Chip tone="warn">读取中</Chip></div>}
      {statusFailure && <div className="mffai-row mffai-fetch bad"><Icon name="alert" size={14} /><FailChip failure={statusFailure} /></div>}
      {st?.state === 'failed' && (
        <div className="mffai-row mffai-fetch bad">
          <Icon name="alert" size={14} />
          <Chip tone="bad">读取失败</Chip>
          {st.error && <CodeChip code={st.error} />}
          {st.path && <PText text={st.path} mono />}
        </div>
      )}
      {ready && !upgrade && (
        <>
          <div className="mffai-row mffai-fetch ok"><Icon name="check" size={14} /><Chip tone="ok">就绪</Chip></div>
          {/* 首装(A):整页审阅,盖住插件页 */}
          <div ref={page} className="mffai-cpage">
            <div className="mffai-cpage-b">
              <Consent consent={st.consent!} close={close} grants={grantsEditor} checkedHosts={checkedHosts} />
            </div>
            <div className="mffai-actions mffai-cfoot">
              <Chip tone="line"><Icon name="globe" size={12} />{`联网 ${checkedHosts} 个地址`}</Chip>
              {servers.length > 0 && <Chip tone="line"><Icon name="folder" size={12} />{`项目目录 ${cwdLevels}`}</Chip>}
              <span className="mffai-head-spring" />
              <FailChip failure={failure} />
              <button className="set-btn" disabled={busy} onClick={cancel}>取消</button>
              <button className="set-btn" disabled={busy} onClick={() => confirm(false)}>安装</button>
              <button className="set-btn mffai-primary" disabled={busy} onClick={() => confirm(true)}><Icon name="check" size={13} />安装并启用</button>
            </div>
          </div>
        </>
      )}
      {ready && upgrade && (
        <>
          {/* 升级(B):弹窗里,变更清单 + 每一节 */}
          <Consent consent={st.consent!} layout="upgrade" close={close} grants={grantsEditor} />
          <div className="mffai-actions mffai-cfoot">
            {totals.length > 0 && (
              <span className="mffai-ctotal">
                <Chip tone="ok" sq>{`+ ${sum('add')}`}</Chip>
                <Chip tone="warn" sq>{`~ ${sum('mod')}`}</Chip>
                <Chip tone="bad" sq>{`− ${sum('del')}`}</Chip>
              </span>
            )}
            <span className="mffai-head-spring" />
            <FailChip failure={failure} />
            <button className="set-btn" disabled={busy} onClick={cancel}>取消</button>
            <button className="set-btn" disabled={busy} onClick={() => confirm(false)}>升级但停用</button>
            <button className="set-btn mffai-primary" disabled={busy} onClick={() => confirm(true)}><Icon name="check" size={13} />{wasEnabled === false ? '升级并启用' : '升级'}</button>
          </div>
        </>
      )}
      {!ready && (
        <div className="mffai-actions">
          <button className="set-btn" disabled={busy} onClick={cancel}>取消</button>
          <FailChip failure={failure} />
        </div>
      )}
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

  return (
    <div className="mffai-group mffai-install">
      <div className="mffai-pmcp-head">
        <h2 className="mffai-ptitle">添加插件</h2>
        <span className="mffai-head-spring" />
        <button className="mffai-iconbtn" onClick={onClose}><Icon name="x" size={14} /><span className="mffai-sr">关闭</span></button>
      </div>
      <div className="mffai-seg mffai-iseg" role="tablist">
        {([['path', '本地路径', 'folder'], ['git', 'git', 'branch']] as const).map(([id, name, icon]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}><Icon name={icon} size={13} />{name}</button>
        ))}
      </div>
      {tab === 'path'
        ? <div className="mffai-row mffai-ifld"><span className="mffai-k">路径</span><PathField kind="directory" label="路径" value={path} onChange={setPath} /></div>
        : (
          <>
            <div className="mffai-row mffai-ifld"><span className="mffai-k">地址</span><input aria-label="地址" value={url} onChange={(e) => setUrl(e.target.value)} /></div>
            <div className="mffai-row mffai-ifld">
              <span className="mffai-k">ref</span><input aria-label="ref" value={ref} onChange={(e) => setRef(e.target.value)} />
              <span className="mffai-k">子目录</span><input aria-label="子目录" value={subpath} onChange={(e) => setSubpath(e.target.value)} />
            </div>
          </>
        )}
      <div className="mffai-actions mffai-iact">
        <FailChip failure={failure} />
        <button className="set-btn mffai-primary" disabled={busy || !source() || stagingId !== null} onClick={prepare}><Icon name="dl" size={13} />读取</button>
      </div>
      {stagingId && (
        <div className="mffai-irec">
          <div className="mffai-sech"><span>获取记录</span></div>
          <Staging stagingId={stagingId} onClose={onClose} onInstalled={onInstalled} />
        </div>
      )}
    </div>
  )
}
