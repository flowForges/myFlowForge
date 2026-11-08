// 插件页(08 §13.1):plugins.list 每行 id、版本、格式、来源(路径或 url@commit)、状态 + problems 代码、启用开关、详情;
// 启用成功后这一行出现 新会话(09 §15)。页头:store_recovered → 存储已恢复 + 丢弃遗留(确认框,plugins.store.discard)。
// 下面:添加(安装和同意页)、选中插件的详情、MCP 服务总表、开发插件一组。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PluginListResult } from '@mffai/protocol'
import { call, isUnsupported, retryable } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { route } from '../route'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { Confirm } from '../ui/Confirm'
import { PText } from '../ui/PText'
import { Install } from './Install'
import { PluginDetail } from './PluginDetail'
import { McpTable } from './McpTable'
import { DevMode } from './DevMode'
import { FailChip, useAction } from './action'

type Row = PluginListResult['plugins'][number]
const STORE_RECOVERED = 'store_recovered'

const sourceText = (s: Row['source']) => (s.kind === 'path' ? s.path : `${s.url}@${s.commit}`)

function PluginRow({ p, newSession, onEnabled, onDetail }: {
  p: Row
  newSession: boolean
  onEnabled: (id: string, enabled: boolean) => void
  onDetail: () => void
}) {
  const retry = useRef(retryable()).current
  const { run, busy, failure } = useAction()
  const toggle = (enabled: boolean) => void run('plugins.setEnabled', async () => {
    const key = String(enabled)
    await call('plugins.setEnabled', { commandId: retry.id(key), id: p.id, enabled })
    retry.done(key)
    onEnabled(p.id, enabled)
  })
  return (
    <div className="mffai-row mffai-taskrow" data-plugin={p.id}>
      <PText text={p.id} mono />
      <PText text={p.version} mono />
      <CodeChip code={p.format} />
      <PText text={sourceText(p.source)} mono />
      <Chip tone={p.state === 'ok' ? 'ok' : 'bad'}>{p.state === 'ok' ? '正常' : '有问题'}</Chip>
      {p.problems.map((c) => <CodeChip key={c} code={c} />)}
      <label className="mffai-switch">
        <input type="checkbox" role="switch" aria-label={`启用 ${p.id}`} checked={p.enabled} disabled={busy} onChange={(e) => toggle(e.target.checked)} />
        启用
      </label>
      {newSession && p.enabled && <button className="set-btn mffai-primary" onClick={() => route.set({ page: 'chat', newSession: {} })}>新会话</button>}
      <button className="set-btn" onClick={onDetail}>详情</button>
      <FailChip failure={failure} />
    </div>
  )
}

function DiscardStore({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const retry = useRef(retryable()).current
  const { run, busy, failure, alive } = useAction()
  const discard = () => void run('plugins.store.discard', async () => {
    await call('plugins.store.discard', { commandId: retry.id('discard') })
    retry.done('discard')
    if (alive.current) setOpen(false)
    onDone()
  })
  return (
    <>
      <Chip tone="warn">存储已恢复</Chip>
      <button className="set-btn" onClick={() => setOpen(true)}>丢弃遗留</button>
      {open && (
        <Confirm title="丢弃遗留" rows={[['问题', <CodeChip key="c" code={STORE_RECOVERED} />], ['删除', '记录以外的插件代码和数据'], ['删除', '坏记录里列的凭据']]}
          confirmLabel="丢弃遗留" danger busy={busy} onCancel={() => setOpen(false)} onConfirm={discard}>
          <FailChip failure={failure} />
        </Confirm>
      )}
    </>
  )
}

export default function PluginsPage() {
  const [list, setList] = useState<PluginListResult | null>(null)
  const [failed, setFailed] = useState<'unsupported' | 'failed' | null>(null)
  const [statusProblems, setStatusProblems] = useState<readonly string[]>([])
  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  /** 在这页上启用成功的插件:它们的行有 新会话 */
  const [enabledHere, setEnabledHere] = useState<ReadonlySet<string>>(new Set())
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(() => {
    void call('plugins.list').then(
      (r) => { if (alive.current) { setList(r); setFailed(null) } },
      (e) => { if (alive.current) setFailed(isUnsupported(e) ? 'unsupported' : 'failed') },
    )
    void call('status').then((s) => { if (alive.current) setStatusProblems(s.problems ?? []) }, () => {})
  }, [])
  useEffect(load, [load])
  useMffaiReset(load)
  useMffaiEvent({ types: [
    'plugins.installed', 'plugins.upgraded', 'plugins.enabled', 'plugins.disabled', 'plugins.uninstalled',
    'plugins.integrity.failed', 'plugins.store.discarded', 'plugins.dev.trusted', 'plugin.activated', 'plugin.failed',
  ] }, load)

  const onEnabled = (id: string, enabled: boolean) => {
    setEnabledHere((s) => {
      const n = new Set(s)
      if (enabled) n.add(id)
      else n.delete(id)
      return n
    })
    load()
  }

  if (failed === 'unsupported') return <div className="mffai-pane mffai-plugins"><Chip tone="bad">不支持</Chip></div>
  const plugins = list?.plugins ?? []
  const pageProblems = list?.problems ?? []
  const current = selected ? plugins.find((p) => p.id === selected) : undefined
  return (
    <div className="mffai-pane mffai-plugins">
      <div className="mffai-row">
        {pageProblems.includes(STORE_RECOVERED) && <DiscardStore onDone={load} />}
        {pageProblems.filter((c) => c !== STORE_RECOVERED).map((c) => <CodeChip key={c} code={c} />)}
        {failed === 'failed' && <span className="mffai-fail">失败</span>}
        {!adding && <button className="set-btn mffai-primary" onClick={() => setAdding(true)}>添加</button>}
      </div>
      {adding && (
        <Install onClose={() => setAdding(false)} onInstalled={(id, enabled) => { setAdding(false); onEnabled(id, enabled) }} />
      )}
      {plugins.length > 0 && (
        <div className="mffai-group" data-section="plugins">
          {plugins.map((p) => (
            <PluginRow key={p.id} p={p} newSession={enabledHere.has(p.id)} onEnabled={onEnabled} onDetail={() => setSelected(p.id)} />
          ))}
        </div>
      )}
      {current && (
        <PluginDetail key={current.id} plugin={current} showNewSession={enabledHere.has(current.id)} onEnabled={onEnabled}
          onClose={() => { setSelected(null); load() }} />
      )}
      <McpTable />
      <DevMode dev={list?.dev ?? []} problems={statusProblems} onChanged={load} />
    </div>
  )
}
