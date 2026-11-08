// 连接 · 执行器(08 §10.2):executor.list,手动刷新(executor.refresh)。旧后台没有这两个方法(-32601):不支持。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExecutorListResult } from '@mffai/protocol'
import { call, cmd, isUnsupported, toCallError } from '../rpc'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { label } from '../labels'

type ExecutorRow = ExecutorListResult['executors'][number]

const AUTH_LABEL: Record<ExecutorRow['auth'], string> = { ok: '已登录', missing: '未登录', unknown: '未知' }
const AUTH_TONE = { ok: 'ok', missing: 'bad', unknown: 'muted' } as const

function ExecutorItem({ e }: { e: ExecutorRow }) {
  return (
    <div className="mffai-row" data-executor={e.id}>
      <span>{e.id}</span>
      {e.installed
        ? <Chip tone="ok">{`已安装${e.version ? ` ${e.version}` : ''}`}</Chip>
        : <Chip>未安装</Chip>}
      <Chip tone={AUTH_TONE[e.auth]}>{AUTH_LABEL[e.auth]}</Chip>
      <Chip>{label('isolation', e.isolation)}</Chip>
      {e.missing.map((code) => <CodeChip key={code} code={code} />)}
    </div>
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
      <div className="mffai-actions">
        {!unsupported && <button className="set-btn" disabled={refreshing} onClick={refresh}>刷新</button>}
        {unsupported && <Chip>不支持</Chip>}
        {refreshing && <Chip tone="warn">刷新中</Chip>}
        {failed && <span className="mffai-fail">失败</span>}
      </div>
      {rows?.map((e) => <ExecutorItem key={e.id} e={e} />)}
    </div>
  )
}
