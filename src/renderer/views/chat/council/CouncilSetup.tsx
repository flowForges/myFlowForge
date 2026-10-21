import { useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, ProviderInfo } from '@shared/types'
import { getBuiltinProvider } from '@shared/providerCatalog'
import {
  COUNCIL_CONSENSUS_CAPS, COUNCIL_DEFAULT_ROUNDS, estimateCouncilMinutes, isCouncilProvider, validateCouncilConfig,
  type CouncilConfig, type CouncilMaterials, type CouncilMode, type CouncilSeat,
} from '@shared/council'
import type { CouncilLastConfig } from '../../../state/useCouncil'
import { agentIcon } from '../../../components/AgentLogo'
import './council.css'

const MIN_ROUNDS = 1
const MAX_ROUNDS = 5

type MaterialKind = 'none' | 'uncommitted' | 'range' | 'files'
const MATERIAL_KINDS: { id: MaterialKind; label: string }[] = [
  { id: 'none', label: '无' },
  { id: 'uncommitted', label: '未提交的改动' },
  { id: 'range', label: '提交区间' },
  { id: 'files', label: '文件' },
]

const FALLBACK_LOGO = { bg: 'oklch(70% .03 250 / .25)', color: 'var(--fg-2)', glyph: '◆' }
export function Logo({ id }: { id: string }) {
  const meta = getBuiltinProvider(id)
  const lg = meta ? { bg: meta.brandBg, color: meta.brandColor, glyph: meta.glyph } : FALLBACK_LOGO
  return <span className="mc-logo-sm" style={{ background: lg.bg, color: lg.color }}>{agentIcon(id, lg.glyph)}</span>
}

// ★席位 id = provider:model —— 同一组合最多当一次席位,所以天然唯一;主持人跑在独立会话里,
//  id 加 leader: 前缀,即便和某个席位同组合也不会撞上那个席位的发言归属。
export function makeSeat(p: ProviderInfo, model: string): CouncilSeat {
  const m = p.models.find(x => x.id === model)
  return { id: `${p.id}:${model}`, provider: p.id, model, label: `${p.displayName} · ${m?.label ?? model}` }
}
export const asLeader = (s: CouncilSeat): CouncilSeat => ({ ...s, id: `leader:${s.provider}:${s.model}` })

const START_ERRORS: Record<string, string> = {
  busy: '当前会话正忙',
  'provider-not-installed': '配置无效',
  'project-invalid': '配置无效',
  'materials-invalid': '参考材料无效',
}

/**
 * council:start 失败时给用户看的一句话。ipcRenderer.invoke 的错误长这样:
 * "Error invoking remote method 'council:start': Error: busy" —— 取最后那段当错误码。
 */
export function councilStartError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const msg = raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '').trim()
  if (START_ERRORS[msg]) return START_ERRORS[msg]
  // validateCouncilConfig 的错误码(topic-empty / seats-too-few / seat-duplicate …)一律归为配置无效
  if (/^[a-z]+(?:-[a-z]+)+$/.test(msg)) return '配置无效'
  return msg || '配置无效'
}

export const CHEV = <svg className="dd-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>

/** 「CLI → 模型」两级选择,复用 Composer 的 .menu / .menu-pop / .menu-item。 */
export function SeatPicker({ className, label, trigger, providers, taken, onPick }: {
  className: string
  label: string
  trigger: React.ReactNode
  providers: ProviderInfo[]
  taken?: Set<string>
  onPick: (p: ProviderInfo, model: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [prov, setProv] = useState<ProviderInfo | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  const models = prov ? prov.models.filter(m => !taken?.has(`${prov.id}:${m.id}`)) : []
  return (
    <div ref={ref} className={`menu ${className}${open ? ' open' : ''}`}>
      <button type="button" className="cb-btn" aria-label={label} onClick={() => { setProv(null); setOpen(o => !o) }}>{trigger}</button>
      {open && (
        <div className="menu-pop">
          {prov ? (
            <>
              <button type="button" className="menu-item council-back" onClick={() => setProv(null)}>
                ‹ <Logo id={prov.id} />{prov.displayName}
              </button>
              {models.map(m => (
                <button type="button" className="menu-item" key={m.id} data-cmodel={m.id} onClick={() => { onPick(prov, m.id); setOpen(false) }}>
                  {m.label}
                </button>
              ))}
            </>
          ) : providers.map(p => (
            <button type="button" className="menu-item" key={p.id} data-cprov={p.id} onClick={() => setProv(p)}>
              <Logo id={p.id} />{p.displayName}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

type Props = {
  providers: ProviderInfo[]
  lastConfig: CouncilLastConfig | null
  projects: () => Promise<{ name: string; cwd: string }[]>
  /** 议题 = 输入框正文;附件 = 输入框附件。 */
  topic: string
  attachments: Attachment[]
  /** 普通对话正忙 / 本会话已有一场共商未结束。 */
  blocked: boolean
  /** 收起时仍保持挂载(草稿不丢),只是不显示。 */
  hidden?: boolean
  onStart: (cfg: CouncilConfig) => void | Promise<void>
}

export function CouncilSetup({ providers, lastConfig, projects, topic, attachments, blocked, hidden, onStart }: Props) {
  // 只列本机装了、且第一期开放的 CLI;没有模型列表的选不出席位,也不列。
  const pickable = useMemo(
    () => providers.filter(p => p.installed && isCouncilProvider(p.id) && p.models.length > 0),
    [providers],
  )
  // 记住的席位:CLI 还装着、模型也还在它的列表里才算数。
  const usable = (s: CouncilSeat) => pickable.some(p => p.id === s.provider && p.models.some(m => m.id === s.model))

  const [seats, setSeats] = useState<CouncilSeat[]>([])
  const [leader, setLeader] = useState<CouncilSeat | null>(null)
  const [mode, setMode] = useState<CouncilMode>({ kind: 'rounds', rounds: COUNCIL_DEFAULT_ROUNDS })
  const [projectCwd, setProjectCwd] = useState('')
  const [kind, setKind] = useState<MaterialKind>('none')
  const [range, setRange] = useState('')
  const [files, setFiles] = useState('')
  const [projectList, setProjectList] = useState<{ name: string; cwd: string }[]>([])

  // ★上次的选择(按工作区)是异步到的;用户在它到之前已经动过设置区,就不拿旧值覆盖。
  const touched = useRef(false)
  const applied = useRef(false)
  useEffect(() => {
    // provider 列表也可能还没到:等它到了再套,否则记住的席位会被当成「没装」全部筛掉。
    if (!lastConfig || !pickable.length || applied.current || touched.current) return
    applied.current = true
    const kept = lastConfig.seats.filter(usable)
    setSeats(kept)
    setLeader(usable(lastConfig.leader) ? lastConfig.leader : kept[0] ? asLeader(kept[0]) : null)
    setMode(lastConfig.mode)
    const mt = lastConfig.materials
    if (mt?.projectCwd) {
      setProjectCwd(mt.projectCwd)
      if (mt.diff === 'uncommitted') setKind('uncommitted')
      else if (mt.diff) { setKind('range'); setRange(mt.diff.range) }
      else if (mt.files?.length) { setKind('files'); setFiles(mt.files.join(', ')) }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastConfig, pickable])

  useEffect(() => {
    let live = true
    void projects().then(list => {
      if (!live) return
      setProjectList(list)
      // ★只有一个项目时自动选中(spec §5.3);记住的项目已不在工作区里就清掉。
      setProjectCwd(cur => (cur && list.some(p => p.cwd === cur) ? cur : list.length === 1 ? list[0].cwd : ''))
    }).catch(() => {})
    return () => { live = false }
  }, [projects])

  const touch = () => { touched.current = true }

  function addSeat(p: ProviderInfo, model: string) {
    touch()
    const s = makeSeat(p, model)
    setSeats(cur => (cur.some(x => x.id === s.id) ? cur : [...cur, s]))
    setLeader(cur => cur ?? asLeader(s))
  }
  function removeSeat(id: string) { touch(); setSeats(cur => cur.filter(s => s.id !== id)) }

  const dragFrom = useRef<number | null>(null)
  function dropAt(to: number) {
    const from = dragFrom.current
    dragFrom.current = null
    if (from == null || from === to) return
    touch()
    setSeats(cur => {
      const next = cur.slice()
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  const fileList = files.split(',').map(f => f.trim()).filter(Boolean)
  const materials: CouncilMaterials | undefined = projectCwd
    ? {
        projectCwd,
        ...(kind === 'uncommitted' ? { diff: 'uncommitted' as const } : {}),
        ...(kind === 'range' ? { diff: { range: range.trim() } } : {}),
        ...(kind === 'files' ? { files: fileList } : {}),
      }
    : undefined
  const materialsOk = !projectCwd || (kind === 'range' ? !!range.trim() : kind === 'files' ? fileList.length > 0 : true)

  const cfg = { topic: topic.trim(), attachments, seats, leader: leader as CouncilSeat, mode, ...(materials ? { materials } : {}) }
  const canStart = !blocked && materialsOk && validateCouncilConfig(cfg) === null
  const minutes = Math.ceil(estimateCouncilMinutes(cfg)[1])

  const taken = useMemo(() => new Set(seats.map(s => s.id)), [seats])
  const rounds = mode.kind === 'rounds' ? mode.rounds : COUNCIL_DEFAULT_ROUNDS
  const setRounds = (n: number) => { touch(); setMode({ kind: 'rounds', rounds: Math.min(MAX_ROUNDS, Math.max(MIN_ROUNDS, n)) }) }

  return (
    <div className="council-setup" hidden={hidden}>
      <div className="council-row">
        <div className="council-seg" role="group">
          <button type="button" aria-pressed={mode.kind === 'rounds'} className={mode.kind === 'rounds' ? 'on' : ''} onClick={() => setRounds(rounds)}>按轮次</button>
          <button
            type="button"
            aria-pressed={mode.kind === 'consensus'}
            className={mode.kind === 'consensus' ? 'on' : ''}
            onClick={() => { touch(); setMode({ kind: 'consensus', ...COUNCIL_CONSENSUS_CAPS }) }}
          >讨论到共识</button>
        </div>
        {mode.kind === 'rounds' && (
          <div className="council-stepper">
            <button type="button" disabled={rounds <= MIN_ROUNDS} onClick={() => setRounds(rounds - 1)}>−</button>
            <span className="council-rounds">{rounds}</span>
            <button type="button" disabled={rounds >= MAX_ROUNDS} onClick={() => setRounds(rounds + 1)}>+</button>
          </div>
        )}
        <SeatPicker
          className="council-leader"
          label={`👑 ${leader?.label ?? ''}`.trim()}
          trigger={<>👑{leader && <><Logo id={leader.provider} /><span>{leader.label}</span></>}{CHEV}</>}
          providers={pickable}
          onPick={(p, m) => { touch(); setLeader(asLeader(makeSeat(p, m))) }}
        />
      </div>

      <div className="council-row council-seats">
        {seats.map((s, i) => (
          <span
            key={s.id}
            className="council-seat"
            data-seat={s.id}
            draggable
            onDragStart={e => {
              dragFrom.current = i
              try { e.dataTransfer?.setData('text/plain', s.id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move' } catch { /* 合成事件 */ }
            }}
            onDragOver={e => { if (dragFrom.current != null) e.preventDefault() }}
            onDrop={e => { e.preventDefault(); dropAt(i) }}
            onDragEnd={() => { dragFrom.current = null }}
          >
            <Logo id={s.provider} />
            <span className="council-seat-label">{s.label}</span>
            <button type="button" aria-label={`移除 ${s.label}`} onClick={() => removeSeat(s.id)}>✕</button>
          </span>
        ))}
        {seats.length < 6 && (
          <SeatPicker className="council-add" label="添加讨论方" trigger="＋" providers={pickable} taken={taken} onPick={addSeat} />
        )}
      </div>

      <div className="council-row">
        <select className="council-project" value={projectCwd} onChange={e => { touch(); setProjectCwd(e.target.value) }}>
          <option value="">—</option>
          {projectList.map(p => <option key={p.cwd} value={p.cwd}>{p.name}</option>)}
        </select>
        {projectCwd && (
          <div className="council-seg" role="group">
            {MATERIAL_KINDS.map(k => (
              <button key={k.id} type="button" aria-pressed={kind === k.id} className={kind === k.id ? 'on' : ''} onClick={() => { touch(); setKind(k.id) }}>{k.label}</button>
            ))}
          </div>
        )}
        {projectCwd && kind === 'range' && (
          <input className="council-input council-range" value={range} placeholder="a..b" onChange={e => { touch(); setRange(e.target.value) }} />
        )}
        {projectCwd && kind === 'files' && (
          <input className="council-input council-files" value={files} placeholder="src/a.ts, src/b.ts" onChange={e => { touch(); setFiles(e.target.value) }} />
        )}
        <div className="council-spacer" />
        <span className="council-eta">约 {minutes} 分钟</span>
        <button
          type="button"
          className="council-start"
          disabled={!canStart}
          onClick={() => { if (canStart) void onStart(cfg) }}
        >开始讨论</button>
      </div>
    </div>
  )
}
