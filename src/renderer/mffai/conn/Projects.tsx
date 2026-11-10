// Telegram 项目表(08 §10.3):别名、路径(PathField)、AutoSwitch(同一个标签)。沙箱级别不是 full 时 AutoSwitch
// 禁用,旁边是级别块(07:后台在非 full 时拒绝 auto);已经开着的那一格仍能关掉,否则后台拒掉每一次保存,
// 连停用渠道都存不上。保存走 config.set,带整份配置:不认识的键原样回去,后台的 ConfigSchema 以后多了字段
// 也不会被这页抹掉。整页只有一个保存器:一次保存在飞、加上它之后的重取,都完成了下一次才能开始,
// 每次都在最新的配置上改(不会拿旧的展开把别处刚改的 enabled 翻回去)。
import { useEffect, useRef, useState } from 'react'
import type { SandboxStatus, TelegramConfig, TelegramProject } from '@mffai/protocol'
import { Icon } from '../shell/icons'
import { call, isUnsupported, retryable, toCallError } from '../rpc'
import { label } from '../labels'
import { AutoSwitch } from '../ui/AutoSwitch'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { PathField } from '../ui/PathField'

const ERR_INVALID = -32602
const INVALID_PROJECT = 'invalid_project'

/** config.get 的原样对象:可能带这页不认识的键 */
export type FullConfig = TelegramConfig & Record<string, unknown>
type Project = TelegramProject & Record<string, unknown>
export type SaveFailure = { code: string; data?: unknown } | 'unsupported' | 'failed'
/** skipped:另一次保存还没完(含重取),这次没发 */
export type SaveOutcome = 'ok' | 'skipped' | SaveFailure

export interface ConfigSaver {
  save(patch: Partial<FullConfig>): Promise<SaveOutcome>
  busy: boolean
}

/**
 * 整页共用的 config.set。latest() 给最新的配置(重取后的),patch 盖在它上面;保存完(成功或失败)先 reload,
 * 之后才放下一次。同一份配置重试(超时后)用同一个 commandId;两次点击落在同一帧里只发一次
 */
export function useConfigSaver(latest: () => FullConfig | null, reload: () => Promise<unknown>): ConfigSaver {
  const retry = useRef(retryable()).current
  const inflight = useRef(false)
  const alive = useRef(true)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const save = async (patch: Partial<FullConfig>): Promise<SaveOutcome> => {
    const base = latest()
    if (!base || inflight.current) return 'skipped'
    inflight.current = true
    setBusy(true)
    const config = { ...base, ...patch }
    const key = JSON.stringify(config)
    let out: SaveOutcome
    try {
      await call('channel.telegram.config.set', { commandId: retry.id(key), config })
      retry.done(key)
      out = 'ok'
    } catch (e) {
      const c = toCallError(e)
      console.error('mffai channel.telegram.config.set', c.code)
      out = isUnsupported(c) ? 'unsupported'
        : c.code === ERR_INVALID && c.message ? { code: c.message, ...(c.data !== undefined && { data: c.data }) }
        : 'failed'
    }
    try { await reload() } catch { /* reload 自己记日志 */ }
    inflight.current = false
    if (alive.current) setBusy(false)
    return out
  }
  return { save, busy }
}

export function SaveFailureChip({ failure }: { failure: SaveFailure | null }) {
  if (!failure) return null
  if (failure === 'unsupported') return <Chip tone="bad">不支持</Chip>
  if (failure === 'failed') return <span className="mffai-fail">失败</span>
  return <CodeChip code={failure.code} />
}

type Row = { key: number; p: Project }
/** 一行的问题:空的别名 / 路径,或后台点名这一行的拒绝代码 */
type Bad = { name?: boolean; path?: boolean; code?: string }

/** invalid_project 的 data 点名了哪一行:{index} 或 {name} */
function rowOf(rows: readonly Row[], data: unknown): Row | undefined {
  const d = (data && typeof data === 'object' ? data : {}) as { index?: unknown; name?: unknown }
  if (typeof d.index === 'number') return rows[d.index]
  if (typeof d.name === 'string') return rows.find((r) => r.p.name === d.name)
  return undefined
}

export function Projects({ config, level, saver }: {
  config: FullConfig
  level?: SandboxStatus['level']
  saver: ConfigSaver
}) {
  const next = useRef(0)
  const toRows = (ps: readonly Project[]): Row[] => ps.map((p) => ({ key: next.current++, p: { ...p } }))
  const [rows, setRows] = useState<Row[]>(() => toRows(config.projects))
  const [dirty, setDirty] = useState(false)
  const [failure, setFailure] = useState<SaveFailure | null>(null)
  const [bad, setBad] = useState<ReadonlyMap<number, Bad>>(new Map())

  // 后台的配置换了(别处保存、保存后重取):没动过的草稿跟着换,动过的不覆盖
  const incoming = JSON.stringify(config.projects)
  useEffect(() => {
    if (!dirty) setRows(toRows(config.projects))
  }, [incoming, dirty]) // eslint-disable-line react-hooks/exhaustive-deps

  const unmark = (key: number) => setBad((b) => {
    if (!b.has(key)) return b
    const m = new Map(b)
    m.delete(key)
    return m
  })
  const edit = (key: number, patch: Partial<TelegramProject>) => {
    setDirty(true)
    unmark(key)
    setRows((rs) => rs.map((r) => (r.key === key ? { key, p: { ...r.p, ...patch } } : r)))
  }
  const remove = (key: number) => { setDirty(true); unmark(key); setRows((rs) => rs.filter((r) => r.key !== key)) }
  const add = () => { setDirty(true); setRows((rs) => [...rs, { key: next.current++, p: { name: '', path: '', auto: false } }]) }

  const autoOk = level === 'full'
  const submit = async () => {
    const empty = new Map<number, Bad>()
    for (const r of rows) {
      const b: Bad = { ...(!r.p.name.trim() && { name: true }), ...(!r.p.path.trim() && { path: true }) }
      if (b.name || b.path) empty.set(r.key, b)
    }
    setFailure(null)
    setBad(empty)
    if (empty.size) return
    const sent = rows
    const out = await saver.save({ projects: sent.map((r) => r.p) })
    if (out === 'skipped') return
    if (out === 'ok') { setDirty(false); return }
    const named = typeof out === 'object' && out.code === INVALID_PROJECT ? rowOf(sent, out.data) : undefined
    if (named) setBad(new Map([[named.key, { code: INVALID_PROJECT }]]))
    else setFailure(out)
  }

  return (
    <div className="mffai-tg-projects">
      <div className="mffai-sech">
        <span>项目</span>
        <span className="mffai-count">{rows.length}</span>
        <span className="mffai-spring" />
        <button className="set-btn" aria-label="添加项目" onClick={add}><Icon name="plus" size={12} />添加</button>
      </div>
      <div className="mffai-tgcard mffai-tg-plist">
        {rows.map(({ key, p }) => {
          const b = bad.get(key)
          return (
            <div key={key} className={`mffai-row${b ? ' bad' : ''}`} data-project-row {...(b && { 'data-invalid': '' })}>
              <div className="mffai-tg-prow">
                <input aria-label="别名" aria-invalid={b?.name || undefined} value={p.name} onChange={(e) => edit(key, { name: e.target.value })} />
                <PathField kind="directory" label="路径" invalid={b?.path} value={p.path} onChange={(path) => edit(key, { path })} iconOnly />
                <button className="set-btn mffai-iconbtn mffai-danger" onClick={() => remove(key)}><Icon name="trash" size={14} /><span className="mffai-sr">删除</span></button>
              </div>
              <div className="mffai-tg-pauto">
                {/* 非 full 时只许关:开着的要能关掉,不然整份配置都存不上 */}
                <AutoSwitch checked={p.auto} disabled={!autoOk && !p.auto} onChange={(auto) => edit(key, { auto })} />
                {!autoOk && level && <Chip tone="warn">{label('level', level)}</Chip>}
                {b?.code && <CodeChip code={b.code} />}
              </div>
            </div>
          )
        })}
      </div>
      <div className="mffai-actions">
        <button className="set-btn mffai-primary" disabled={!dirty || saver.busy} onClick={() => void submit()}>保存</button>
        <SaveFailureChip failure={failure} />
      </div>
    </div>
  )
}
