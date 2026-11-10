// 记忆页(08 §12):档案、待确认、条目、习惯、变更、状态 六个子页。-32601(插件没起来,memory.health 都答不了)
// → 整页 记忆不可用 + status.plugins 里 memory-default 的 error;否则正常显示,子页各自处理自己的失败。
// 档案的文件编辑器一直挂着,切页签只用 hidden 藏起来(和 DebugPage 的面板同一招):不这样,切走再切回来
// 就把没保存的草稿冲没了。一旦到过 ok(everOk),哪怕后来门禁翻成 unavailable(比方插件半道崩了),也不整个
// 换成"记忆不可用"块抹掉草稿——继续显示标签页和编辑器,编辑器转只读,banner 另外提一句。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryFile } from '@mffai/protocol'
import { call } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { memoryUnsupported } from './unavailable'
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
  // 一旦到过 ok 就记住:后面门禁翻回 unavailable 不再抹掉已经挂着的页面和草稿(见顶部注释)
  const [everOk, setEverOk] = useState(false)
  const [pluginError, setPluginError] = useState<string | undefined>()
  const [tab, setTab] = useState<Tab>('profile')
  const [topics, setTopics] = useState<readonly string[]>([])
  const [filesRoot, setFilesRoot] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const checkAvailable = useCallback(() => {
    void call('memory.health').then(
      () => { if (alive.current) { setGate('ok'); setEverOk(true) } },
      (e) => {
        if (!alive.current) return
        if (!memoryUnsupported(e)) { setGate('ok'); setEverOk(true); return }
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

  // 从没到过 ok:门禁没结果前一片空白,真的不支持就是原来那个紧凑块(没有标签页,没什么可留的草稿)
  if (!everOk) {
    if (gate === 'loading') return <div className="mffai-pane" />
    return (
      <div className="mffai-pane mffai-memory">
        <Chip tone="bad">记忆不可用</Chip>
        {pluginError && <span className="mffai-fail">{pluginError}</span>}
      </div>
    )
  }

  const readOnly = gate !== 'ok'

  return (
    <div className="mffai-pane mffai-memory">
      {gate === 'unavailable' && (
        <div className="mffai-row">
          <Chip tone="bad">记忆不可用</Chip>
          {pluginError && <span className="mffai-fail">{pluginError}</span>}
        </div>
      )}
      <div className="mffai-tabrow">
        <div className="mffai-tabs" role="tablist">
          {TABS.map(([id, name]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={`set-btn${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>{name}</button>
          ))}
        </div>
        {filesRoot && (
          <div className="mffai-tabpath">
            <span className="mffai-path">{filesRoot}</span>
            <CopyButton className="mffai-copy" title="复制路径" text={() => filesRoot} />
          </div>
        )}
      </div>
      {/* 档案一直挂着:切标签页不丢没保存的草稿(和 DebugPage 的面板同一招) */}
      <div className="mffai-group mffai-profile" hidden={tab !== 'profile'}>
        <FileEditor file="USER.md" readOnly={readOnly} />
        <FileEditor file="MEMORY.md" readOnly={readOnly} />
        {topics.map((t) => <FileEditor key={t} file={t} readOnly={readOnly} />)}
      </div>
      {tab === 'proposals' && <Proposals onJumpToFile={jumpToFile} />}
      {tab === 'items' && <Items />}
      {tab === 'habits' && <Habits />}
      {tab === 'changes' && <Changes />}
      {tab === 'health' && <Health />}
    </div>
  )
}
