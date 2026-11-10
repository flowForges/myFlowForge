// 连接 · 执行器(08 §10.2):executor.list,手动刷新(executor.refresh)。旧后台没有这两个方法(-32601):不支持。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExecutorListResult } from '@mffai/protocol'
import { call, cmd, isUnsupported, toCallError } from '../rpc'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { label } from '../labels'
import { Icon } from '../shell/icons'
import { execTint } from '../ui/tint'

type ExecutorRow = ExecutorListResult['executors'][number]

const AUTH_LABEL: Record<ExecutorRow['auth'], string> = { ok: '已登录', missing: '未登录', unknown: '未知' }
const AUTH_TONE = { ok: 'ok', missing: 'bad', unknown: 'muted' } as const

function ExecutorItem({ e }: { e: ExecutorRow }) {
  return (
    <tr data-executor={e.id}>
      <td><div className="mffai-tname"><span className={`mffai-rlogo ${execTint(e.id)}`}><Icon name="term" size={12} /></span><span className="mffai-tool">{e.id}</span></div></td>
      <td>
        <div className="mffai-tstate">
          {e.installed ? <Chip tone="ok">{`已安装${e.version ? ` ${e.version}` : ''}`}</Chip> : <Chip>未安装</Chip>}
        </div>
      </td>
      <td><Chip tone={AUTH_TONE[e.auth]}>{AUTH_LABEL[e.auth]}</Chip></td>
      <td><Chip tone={e.isolation === 'none' ? 'bad' : 'line'}>{label('isolation', e.isolation)}</Chip></td>
      <td><div className="mffai-tstate">{e.missing.map((code) => <CodeChip key={code} code={code} />)}</div></td>
    </tr>
  )
}

export function Executors() {
  const [rows, setRows] = useState<ExecutorRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [unsupported, setUnsupported] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const inflight = useRef(false)
  const alive = useRef(true)

  const load = useCallback(() => {
    void call('executor.list').then(
      (r) => { if (alive.current) { setRows(r.executors); setFailed(false) } },
      (e) => {
        if (!alive.current) return
        if (isUnsupported(e)) { setUnsupported(true); return }
        console.error('mffai executor.list', toCallError(e))
        setFailed(true)
      },
    )
  }, [])

  useEffect(() => {
    alive.current = true
    load()
    return () => { alive.current = false }
  }, [load])

  const refresh = () => {
    if (inflight.current) return
    inflight.current = true
    setRefreshing(true)
    setFailed(false)
    void call('executor.refresh', { commandId: cmd() }).then(
      (r) => { if (alive.current) setRows(r.executors) },
      (e) => {
        if (!alive.current) return
        if (isUnsupported(e)) { setUnsupported(true); return }
        console.error('mffai executor.refresh', toCallError(e))
        setFailed(true)
      },
    ).finally(() => { inflight.current = false; setRefreshing(false) })
  }

  return (
    <div className="mffai-conn mffai-conn-exec">
      <div className="mffai-sech">
        <span className="mffai-tcard-title">执行器</span>
        {rows && <span className="mffai-count">{rows.length}</span>}
        <span className="mffai-spring" />
        {unsupported && <Chip>不支持</Chip>}
        {refreshing && <Chip tone="warn">刷新中</Chip>}
        {failed && <span className="mffai-fail">失败</span>}
        {!unsupported && (
          <button className="set-btn" disabled={refreshing} onClick={refresh}>
            {refreshing ? <span className="mffai-spin" /> : <Icon name="refresh" size={13} />}刷新
          </button>
        )}
      </div>
      {rows && rows.length > 0 && (
        <div className="mffai-tbox">
          <table className="mffai-tbl mffai-etbl">
            <thead><tr>{['执行器', '安装', '登录', '隔离', '缺少'].map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{rows.map((e) => <ExecutorItem key={e.id} e={e} />)}</tbody>
          </table>
        </div>
      )}
    </div>
  )
}
