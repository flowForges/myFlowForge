import { useCallback, useEffect, useMemo, useState } from 'react'
import type { KernelEvent, PluginListResult, StatusResult } from '@mffai/protocol'
import { DebugPanel } from '../DebugPanel'
import { call } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { applyRedaction } from './redact'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'

const KEEP = 1000
type Tab = 'panel' | 'inject' | 'plugins' | 'raw'
const TABS: [Tab, string][] = [['panel', '面板'], ['inject', '注入'], ['plugins', '插件'], ['raw', '原始']]
const INJECTED: ReadonlySet<string> = new Set(['memory.injected', 'plugins.injected'])
const PLUGIN_EVENTS = [
  'plugin.activated', 'plugin.failed', 'plugins.installed', 'plugins.upgraded', 'plugins.enabled', 'plugins.disabled',
  'plugins.uninstalled', 'plugins.integrity.failed', 'plugins.dev.loaded', 'plugins.dev.trusted', 'kernel.started',
] as const

interface P { turnId?: unknown; text?: unknown; kind?: unknown; truncated?: unknown; skill?: unknown; mcp?: unknown }
const pl = (e: KernelEvent) => (e.payload ?? {}) as P
const turnOf = (e: KernelEvent) => (typeof pl(e).turnId === 'string' ? (pl(e).turnId as string) : undefined)

function merge(older: KernelEvent[], live: KernelEvent[]): KernelEvent[] {
  const seen = new Set(live.map((e) => e.seq))
  return [...older.filter((e) => !seen.has(e.seq)), ...live].sort((a, b) => a.seq - b.seq).slice(-KEEP)
}

/** 调试页自己的事件缓存:tail + 实时,按 seq 去重,events.redacted 就地抹掉 */
function useDebugEvents(): KernelEvent[] {
  const [events, setEvents] = useState<KernelEvent[]>([])
  const load = useCallback((replace: boolean) => {
    void call('events.tail', { limit: KEEP })
      .then((r) => setEvents((es) => merge(r.events, replace ? [] : es)))
      .catch(() => {})
  }, [])
  useEffect(() => load(false), [load])
  useMffaiReset(() => load(true))
  useMffaiEvent({}, (e) => setEvents((es) => [...(e.type === 'events.redacted' ? applyRedaction(es, e) : es), e].slice(-KEEP)))
  return events
}

function usePlugins(): { status?: StatusResult; list?: PluginListResult } {
  const [status, setStatus] = useState<StatusResult>()
  const [list, setList] = useState<PluginListResult>()
  const load = useCallback(() => {
    void call('status').then(setStatus).catch(() => {})
    void call('plugins.list').then(setList).catch(() => {})
  }, [])
  useEffect(load, [load])
  useMffaiEvent({ types: PLUGIN_EVENTS }, load)
  useMffaiReset(load)
  return { status, list }
}

function Injected({ events }: { events: KernelEvent[] }) {
  const items = events.filter((e) => INJECTED.has(e.type))
  return (
    <div className="mffai-injects">
      {items.map((e) => {
        const p = pl(e)
        return (
          <div key={e.seq} className="mffai-card mffai-inject">
            <div className="mffai-actions">
              <CodeChip code={e.type} />
              {typeof p.kind === 'string' && <Chip>{p.kind === 'session' ? '会话' : '轮'}</Chip>}
              {p.skill === true && <Chip>技能</Chip>}
              {p.mcp === true && <Chip>MCP</Chip>}
              {turnOf(e) && <CodeChip code={turnOf(e)!} />}
              {p.truncated === true && <Chip tone="warn">已截断</Chip>}
            </div>
            <pre className="mffai-pre">{String(p.text ?? '')}</pre>
          </div>
        )
      })}
    </div>
  )
}

function Plugins() {
  const { status, list } = usePlugins()
  return (
    <div className="mffai-card mffai-conn">
      {status?.plugins.map((p) => (
        <div key={p.id} className="mffai-row">
          <span>{p.id}</span>
          <CodeChip code={p.state} />
          {p.trust === 'dev' && <Chip tone="bad">完全访问</Chip>}
          {p.error && <code className="mffai-err">{p.error}</code>}
        </div>
      ))}
      {!!status?.problems?.length && (
        <div className="mffai-row"><span className="mffai-k">状态</span>{status.problems.map((c) => <CodeChip key={c} code={c} />)}</div>
      )}
      {!!list?.problems.length && (
        <div className="mffai-row"><span className="mffai-k">插件库</span>{list.problems.map((c) => <CodeChip key={c} code={c} />)}</div>
      )}
    </div>
  )
}

function Raw({ events }: { events: KernelEvent[] }) {
  const [seq, setSeq] = useState<number>()
  const picked = seq === undefined ? undefined : events.find((e) => e.seq === seq)
  return (
    <div className="mffai-raw">
      <ul role="listbox" aria-label="事件" className="mffai-card mffai-rawlist">
        {events.map((e) => (
          <li key={e.seq} role="option" aria-selected={e.seq === seq} className={e.seq === seq ? 'on' : undefined} onClick={() => setSeq(e.seq)}>
            <span className="mffai-net">{e.seq}</span> {e.type}{e.sessionId ? ` ${e.sessionId}` : ''}
          </li>
        ))}
      </ul>
      {picked && <pre className="mffai-card mffai-pre">{JSON.stringify(picked, null, 2)}</pre>}
    </div>
  )
}

export default function DebugPage() {
  const [tab, setTab] = useState<Tab>('panel')
  const events = useDebugEvents()
  const [session, setSession] = useState('')
  const [turn, setTurn] = useState('')
  const [types, setTypes] = useState<string[]>([])

  const sessions = useMemo(() => [...new Set(events.map((e) => e.sessionId).filter((s): s is string => !!s))], [events])
  const inSession = useMemo(() => (session ? events.filter((e) => e.sessionId === session) : events), [events, session])
  const turns = useMemo(() => [...new Set(inSession.map(turnOf).filter((t): t is string => !!t))], [inSession])
  const present = useMemo(() => [...new Set(events.map((e) => e.type))].sort(), [events])
  const filtered = useMemo(() => inSession.filter((e) => (!turn || turnOf(e) === turn) && (!types.length || types.includes(e.type))), [inSession, turn, types])

  return (
    <div className="mffai-debug mffai-debugpage">
      <div className="mffai-debughead">
        <div className="mffai-tabs" role="tablist">
          {TABS.map(([id, name]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={`set-btn${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>{name}</button>
          ))}
        </div>
        {tab !== 'panel' && tab !== 'plugins' && (
          <div className="mffai-opts">
            <select className="mffai-filter" aria-label="会话" value={session} onChange={(e) => { setSession(e.target.value); setTurn('') }}>
              <option value="">全部会话</option>
              {sessions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className="mffai-filter" aria-label="轮" value={turn} onChange={(e) => setTurn(e.target.value)}>
              <option value="">全部轮</option>
              {turns.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select className="mffai-filter mffai-types" aria-label="事件类型" multiple value={types}
              onChange={(e) => setTypes([...e.target.selectedOptions].map((o) => o.value))}>
              {present.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        )}
      </div>
      {/* 面板一直挂着:切页签不丢它的缓存 */}
      <div className="mffai-debug mffai-debugpanel" hidden={tab !== 'panel'}><DebugPanel /></div>
      {tab === 'inject' && <Injected events={filtered} />}
      {tab === 'plugins' && <Plugins />}
      {tab === 'raw' && <Raw events={filtered} />}
    </div>
  )
}
