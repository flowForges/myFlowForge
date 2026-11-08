// Telegram 项目表(08 §10.3):别名、路径(PathField)、AutoSwitch(同一个标签)。沙箱级别不是 full 时 AutoSwitch
// 禁用,旁边是级别块(07:后台在非 full 时拒绝 auto)。保存走 config.set,带整份配置:不认识的键原样回去,
// 后台的 ConfigSchema 以后多了字段也不会被这页抹掉。
import { useEffect, useRef, useState } from 'react'
import type { SandboxStatus, TelegramConfig, TelegramProject } from '@mffai/protocol'
import { call, isUnsupported, retryable, toCallError } from '../rpc'
import { label } from '../labels'
import { AutoSwitch } from '../ui/AutoSwitch'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { PathField } from '../ui/PathField'

const ERR_INVALID = -32602

/** config.get 的原样对象:可能带这页不认识的键 */
export type FullConfig = TelegramConfig & Record<string, unknown>
type Project = TelegramProject & Record<string, unknown>
export type SaveFailure = { code: string } | 'unsupported' | 'failed'

/** 一次 config.set。同一份配置重试(超时后)用同一个 commandId;两次点击落在同一帧里只发一次 */
export function useConfigSet() {
  const retry = useRef(retryable()).current
  const inflight = useRef(false)
  const alive = useRef(true)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<SaveFailure | null>(null)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const save = async (config: FullConfig): Promise<boolean> => {
    if (inflight.current) return false
    const key = JSON.stringify(config)
    inflight.current = true
    setBusy(true)
    setFailure(null)
    try {
      await call('channel.telegram.config.set', { commandId: retry.id(key), config })
      retry.done(key)
      return true
    } catch (e) {
      const c = toCallError(e)
      console.error('mffai channel.telegram.config.set', c.code)
      if (alive.current) setFailure(isUnsupported(c) ? 'unsupported' : c.code === ERR_INVALID && c.message ? { code: c.message } : 'failed')
      return false
    } finally {
      inflight.current = false
      if (alive.current) setBusy(false)
    }
  }
  return { save, busy, failure }
}

export function SaveFailureChip({ failure }: { failure: SaveFailure | null }) {
  if (!failure) return null
  if (failure === 'unsupported') return <Chip tone="bad">不支持</Chip>
  if (failure === 'failed') return <span className="mffai-fail">失败</span>
  return <CodeChip code={failure.code} />
}

type Row = { key: number; p: Project }

export function Projects({ config, level, onSaved }: {
  config: FullConfig
  level?: SandboxStatus['level']
  onSaved: () => void
}) {
  const next = useRef(0)
  const toRows = (ps: readonly Project[]): Row[] => ps.map((p) => ({ key: next.current++, p: { ...p } }))
  const [rows, setRows] = useState<Row[]>(() => toRows(config.projects))
  const [dirty, setDirty] = useState(false)
  const { save, busy, failure } = useConfigSet()

  // 后台的配置换了(别处保存、事件后重取):没动过的草稿跟着换,动过的不覆盖
  const incoming = JSON.stringify(config.projects)
  useEffect(() => {
    if (!dirty) setRows(toRows(config.projects))
  }, [incoming]) // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (key: number, patch: Partial<TelegramProject>) => {
    setDirty(true)
    setRows((rs) => rs.map((r) => (r.key === key ? { key, p: { ...r.p, ...patch } } : r)))
  }
  const remove = (key: number) => { setDirty(true); setRows((rs) => rs.filter((r) => r.key !== key)) }
  const add = () => { setDirty(true); setRows((rs) => [...rs, { key: next.current++, p: { name: '', path: '', auto: false } }]) }

  const autoOk = level === 'full'
  const submit = async () => {
    if (await save({ ...config, projects: rows.map((r) => r.p) })) {
      setDirty(false)
      onSaved()
    }
  }

  return (
    <div className="mffai-tg-projects">
      {rows.map(({ key, p }) => (
        <div key={key} className="mffai-row" data-project-row>
          <input aria-label="别名" value={p.name} onChange={(e) => edit(key, { name: e.target.value })} />
          <PathField kind="directory" label="路径" value={p.path} onChange={(path) => edit(key, { path })} />
          <AutoSwitch checked={p.auto} disabled={!autoOk} onChange={(auto) => edit(key, { auto })} />
          {!autoOk && level && <Chip tone="warn">{label('level', level)}</Chip>}
          <button className="set-btn" onClick={() => remove(key)}>删除</button>
        </div>
      ))}
      <div className="mffai-actions">
        <button className="set-btn" onClick={add}>添加项目</button>
        <button className="set-btn" disabled={!dirty || busy} onClick={() => void submit()}>保存</button>
        <SaveFailureChip failure={failure} />
      </div>
    </div>
  )
}
