// 插件页(08 §13.1):plugins.list 每行 id、版本、格式、来源(路径或 url@commit)、状态 + problems 代码、启用开关、详情;
// 启用成功后这一行出现 新会话(09 §15)。页头:store_recovered → 存储已恢复 + 丢弃遗留(确认框,plugins.store.discard)。
// 下面:添加(安装和同意页)、选中插件的详情、MCP 服务总表、开发插件一组。
// 08b:左列 = 已安装 N + 添加、存储已恢复条、全部 MCP 服务一行、插件行、开发插件组;右边一次只看一个视图
// (详情 / 全部 MCP / 添加)。挂载时机不变:McpTable 从进页面起一直挂着(R23),添加和详情各自在
// 按下 添加 / 详情 时挂上、在关掉时卸下;换到别的视图只是 hidden,没确认的暂存不会因此被取消。
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
import { McpTable, type McpCounts } from './McpTable'
import { Icon } from '../shell/icons'
import { DevMode } from './DevMode'
import { FailChip, useAction } from './action'

type Row = PluginListResult['plugins'][number]
const STORE_RECOVERED = 'store_recovered'

const sourceText = (s: Row['source']) => (s.kind === 'path' ? s.path : `${s.url}@${s.commit}`)

function PluginRow({ p, on, newSession, onEnabled, onDetail }: {
  p: Row
  on: boolean
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
  // 整行可点:一个铺满的 详情 按钮垫在下面,插件的文字不放进按钮里
  return (
    <div className={`mffai-row mffai-taskrow mffai-prow${on ? ' on' : ''}`} data-plugin={p.id}>
      <button className="mffai-prow-open" aria-current={on || undefined} onClick={onDetail}><span className="mffai-sr">详情</span></button>
      <span className="mffai-plogo"><Icon name="puzzle" size={15} /></span>
      <span className="mffai-pmain">
        <span className="mffai-pname"><PText text={p.id} /><PText text={p.version} mono /></span>
        <span className="mffai-pchips">
          <Chip tone={p.state === 'ok' ? 'ok' : 'bad'} dot={p.state === 'ok'}>{p.state === 'ok' ? '正常' : '有问题'}</Chip>
          {p.problems.map((c) => <CodeChip key={c} code={c} />)}
          <CodeChip code={p.format} />
        </span>
        <span className="mffai-psrc"><PText text={sourceText(p.source)} mono /></span>
        <FailChip failure={failure} />
      </span>
      <span className="mffai-pend">
        <label className="mffai-switch">
          <input type="checkbox" role="switch" aria-label={`启用 ${p.id}`} checked={p.enabled} disabled={busy} onChange={(e) => toggle(e.target.checked)} />
          <span className="mffai-sr">启用</span>
        </label>
        {newSession && p.enabled && <button className="set-btn mffai-primary" onClick={() => route.set({ page: 'chat', newSession: {} })}>新会话</button>}
      </span>
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
    <div className="mffai-pwarn">
      <Icon name="alert" size={14} />
      <span className="mffai-pwarn-t">存储已恢复</span>
      <button className="set-btn" onClick={() => setOpen(true)}>丢弃遗留</button>
      {open && (
        <Confirm title="丢弃遗留" rows={[['问题', <CodeChip key="c" code={STORE_RECOVERED} />], ['删除', '记录以外的插件代码和数据'], ['删除', '坏记录里列的凭据']]}
          confirmLabel="丢弃遗留" danger busy={busy} onCancel={() => setOpen(false)} onConfirm={discard}>
          <FailChip failure={failure} />
        </Confirm>
      )}
    </div>
  )
}

type View = 'detail' | 'mcp' | 'add' | 'none'

export default function PluginsPage() {
  const [list, setList] = useState<PluginListResult | null>(null)
  const [failed, setFailed] = useState<'unsupported' | 'failed' | null>(null)
  const [statusProblems, setStatusProblems] = useState<readonly string[]>([])
  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  /** 右边看的是哪个;没选插件、没在添加时看全部 MCP */
  const [view, setView] = useState<View>('mcp')
  const [counts, setCounts] = useState<McpCounts | null>(null)
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
  // 选中的插件没了(卸载了)或添加关掉了,右边回到全部 MCP
  const shown: View = view === 'detail' && !current ? 'mcp' : view === 'add' && !adding ? 'mcp' : view
  return (
    <div className="mffai-pane mffai-plugins">
      <aside className="mffai-pcol">
        <div className="mffai-pcol-head">
          <span className="mffai-pcol-title">已安装</span>
          <span className="mffai-count">{plugins.length}</span>
          <span className="mffai-head-spring" />
          <button className="set-btn mffai-primary" onClick={() => { setAdding(true); setView('add') }}><Icon name="plus" size={13} />添加</button>
        </div>
        {pageProblems.includes(STORE_RECOVERED) && <DiscardStore onDone={load} />}
        {(pageProblems.some((c) => c !== STORE_RECOVERED) || failed === 'failed') && (
          <div className="mffai-row mffai-pprob">
            {pageProblems.filter((c) => c !== STORE_RECOVERED).map((c) => <CodeChip key={c} code={c} />)}
            {failed === 'failed' && <span className="mffai-fail">失败</span>}
          </div>
        )}
        <button className={`mffai-pall${shown === 'mcp' ? ' on' : ''}`} aria-current={shown === 'mcp' || undefined} onClick={() => setView('mcp')}>
          <span className="mffai-plogo sm"><Icon name="server" size={13} /></span>
          <span className="mffai-pall-t">全部 MCP 服务</span>
          {counts && counts.problems > 0 && <span className="mffai-pcount bad">{counts.problems}</span>}
          {counts && <span className="mffai-pcount">{counts.total}</span>}
        </button>
        {plugins.length > 0 && (
          <div className="mffai-group mffai-plist" data-section="plugins">
            {plugins.map((p) => (
              <PluginRow key={p.id} p={p} on={shown === 'detail' && current?.id === p.id} newSession={enabledHere.has(p.id)} onEnabled={onEnabled}
                onDetail={() => { setSelected(p.id); setView('detail') }} />
            ))}
          </div>
        )}
        <DevMode dev={list?.dev ?? []} problems={statusProblems} onChanged={load} />
      </aside>
      <section className="mffai-pright">
        {adding && (
          <div className="mffai-pview" data-view="add" hidden={shown !== 'add'}>
            <Install onClose={() => setAdding(false)} onInstalled={(id, enabled) => { setAdding(false); onEnabled(id, enabled) }} />
          </div>
        )}
        {current && (
          <div className="mffai-pview" data-view="detail" hidden={shown !== 'detail'}>
            <PluginDetail key={current.id} plugin={current} showNewSession={enabledHere.has(current.id)} onEnabled={onEnabled}
              onClose={() => { setSelected(null); load() }} />
          </div>
        )}
        <div className="mffai-pview" data-view="mcp" hidden={shown !== 'mcp'}>
          <div className="mffai-pmcp-head">
            <h2 className="mffai-ptitle">全部 MCP 服务</h2>
            {counts && counts.running > 0 && <Chip tone="ok">{`${counts.running} 运行中`}</Chip>}
            {counts && counts.exited > 0 && <Chip tone="bad">{`${counts.exited} 已退出`}</Chip>}
            {counts && counts.refused > 0 && <Chip tone="warn">{`${counts.refused} 未启动`}</Chip>}
          </div>
          <McpTable onCounts={setCounts} />
        </div>
      </section>
    </div>
  )
}
