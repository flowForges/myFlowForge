// 记忆页(08 §12):档案、待确认、条目、习惯、变更、状态 六个子页。-32601(插件没起来,memory.health 都答不了)
// → 整页 记忆不可用 + status.plugins 里 memory-default 的 error;否则正常显示,子页各自处理自己的失败。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryFile } from '@mffai/protocol'
import { call, isUnsupported } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { Chip } from '../ui/Chip'
import { CopyButton } from '../../views/chat/blocks'
import { FileEditor } from './FileEditor'
import { Proposals } from './Proposals'
import Items from './Items'
import { Habits } from './Habits'
import { Changes } from './Changes'
import { Health } from './Health'

const MEMORY_PLUGIN_ID = 'memory-default'
type Tab = 'profile' | 'proposals' | 'items' | 'habits' | 'changes' | 'health'
const TABS: readonly (readonly [Tab, string])[] = [
  ['profile', '档案'], ['proposals', '待确认'], ['items', '条目'], ['habits', '习惯'], ['changes', '变更'], ['health', '状态'],
]

export default function MemoryPage() {
  const [gate, setGate] = useState<'loading' | 'ok' | 'unavailable'>('loading')
  const [pluginError, setPluginError] = useState<string | undefined>()
  const [tab, setTab] = useState<Tab>('profile')
  const [topics, setTopics] = useState<readonly string[]>([])
  const [filesRoot, setFilesRoot] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const checkAvailable = useCallback(() => {
    void call('memory.health').then(
      () => { if (alive.current) setGate('ok') },
      (e) => {
        if (!alive.current) return
        if (!isUnsupported(e)) { setGate('ok'); return }
        setGate('unavailable')
        void call('status').then(
          (s) => { if (alive.current) setPluginError(s.plugins.find((p) => p.id === MEMORY_PLUGIN_ID)?.error) },
          () => {},
        )
      },
    )
  }, [])
  useEffect(checkAvailable, [checkAvailable])
  useMffaiEvent({ types: ['plugin.activated', 'plugin.failed'] }, checkAvailable)
  useMffaiReset(checkAvailable)

  const loadTopics = useCallback(() => {
    void call('memory.list', { layer: 'topic', limit: 500 }).then(
      (r) => { if (alive.current) setTopics([...new Set(r.items.flatMap((it) => (it.file ? [it.file] : [])))].sort()) },
      () => {},
    )
  }, [])
  useEffect(() => { if (gate === 'ok') loadTopics() }, [gate, loadTopics])
  useMffaiEvent({ types: ['memory.updated'] }, (e) => {
    const p = e.payload as { file?: string }
    if (p?.file?.startsWith('topics/')) loadTopics()
  })

  useEffect(() => {
    if (gate !== 'ok') return
    void window.forge.mffai.state().then(
      (s) => { if (alive.current) setFilesRoot(s.roots ? `${s.roots.data}/plugins/${MEMORY_PLUGIN_ID}/files` : null) },
      () => {},
    )
  }, [gate])

  const jumpToFile = (_file: MemoryFile) => setTab('profile')

  if (gate === 'loading') return <div className="mffai-pane" />
  if (gate === 'unavailable') {
    return (
      <div className="mffai-pane mffai-memory">
        <Chip tone="bad">记忆不可用</Chip>
        {pluginError && <span className="mffai-fail">{pluginError}</span>}
      </div>
    )
  }

  return (
    <div className="mffai-pane mffai-memory">
      <div className="mffai-tabs" role="tablist">
        {TABS.map(([id, name]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`set-btn${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>{name}</button>
        ))}
      </div>
      {tab === 'profile' && (
        <div className="mffai-group mffai-profile">
          {filesRoot && (
            <div className="mffai-row">
              <span className="mffai-path">{filesRoot}</span>
              <CopyButton className="mffai-copy" title="复制路径" text={() => filesRoot} />
            </div>
          )}
          <FileEditor file="USER.md" />
          <FileEditor file="MEMORY.md" />
          {topics.map((t) => <FileEditor key={t} file={t} />)}
        </div>
      )}
      {tab === 'proposals' && <Proposals onJumpToFile={jumpToFile} />}
      {tab === 'items' && <Items />}
      {tab === 'habits' && <Habits />}
      {tab === 'changes' && <Changes />}
      {tab === 'health' && <Health />}
    </div>
  )
}
