import { useEffect, useState } from 'react'
import './memory.css'

type Level = 'system' | 'workspace' | 'session'

interface MemoryPaneProps {
  enabled: boolean
  onToggle: (v: boolean) => void
  wsPath?: string
  sessionId?: string
}

// One editable section per memory tier. Loads its content on mount / scope change; 保存 writes it back,
// 清空 wipes it. Editing is decoupled from `enabled` — the user can always view/manage stored memory.
function MemorySection({ title, subtitle, emptyHint, scope, active }: {
  title: string
  subtitle: string
  emptyHint: string
  scope: { level: Level; wsPath?: string; sessionId?: string }
  active: boolean
}) {
  const [content, setContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const key = `${scope.level}:${scope.wsPath ?? ''}:${scope.sessionId ?? ''}`

  useEffect(() => {
    if (!active) return
    let live = true
    setLoaded(false)
    void window.forge.memoryRead({ level: scope.level, wsPath: scope.wsPath, sessionId: scope.sessionId }).then(c => {
      if (live) { setContent(c ?? ''); setLoaded(true) }
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active])

  const blip = (m: string) => { setFlash(m); setTimeout(() => setFlash(null), 1400) }
  const onSave = async () => {
    await window.forge.memoryWrite({ level: scope.level, wsPath: scope.wsPath, sessionId: scope.sessionId, content })
    blip('已保存')
  }
  const onClear = async () => {
    await window.forge.memoryClear({ level: scope.level, wsPath: scope.wsPath, sessionId: scope.sessionId })
    setContent('')
    blip('已清空')
  }

  return (
    <section className="set-group mem-sec">
      <div className="mem-sec-head">
        <div>
          <h4>{title}</h4>
          <p>{subtitle}</p>
        </div>
        {active && (
          <div className="mem-sec-actions">
            <button className="set-btn" onClick={onSave} disabled={!loaded}>保存</button>
            <button className="set-btn danger" onClick={onClear} disabled={!loaded}>清空</button>
            {flash ? <span className="mem-flash">{flash}</span> : null}
          </div>
        )}
      </div>
      {active ? (
        <textarea
          className="mem-ta"
          value={content}
          placeholder={loaded ? '(空)' : '加载中…'}
          onChange={e => setContent(e.target.value)}
        />
      ) : (
        <div className="proj-empty">{emptyHint}</div>
      )}
    </section>
  )
}

export function MemoryPane({ enabled, onToggle, wsPath, sessionId }: MemoryPaneProps) {
  return (
    <div className="mem-pane">
      <div className="set-group">
        <label className="mem-switch">
          <input type="checkbox" checked={enabled} onChange={e => onToggle(e.target.checked)} />
          <span>记忆功能</span>
        </label>
        <p className="mem-switch-hint">
          开启后,助手会自动把对话里的关键信息沉淀为三层记忆并在后续对话里参考。
          关闭是非破坏性的——只暂停读取与写入,已保存的记忆文件保留在本机,重新开启即恢复。
        </p>
      </div>

      <MemorySection
        title="App 全局记忆"
        subtitle="跨项目的用户习惯、常用能力与偏好。所有工作区共享。"
        emptyHint=""
        scope={{ level: 'system' }}
        active={true}
      />
      <MemorySection
        title="当前工作区记忆"
        subtitle="本工作区的项目清单、项目关系、建区目的与技术约定。"
        emptyHint="无活动工作区——进入一个工作区后可在这里查看/编辑它的记忆。"
        scope={{ level: 'workspace', wsPath }}
        active={!!wsPath}
      />
      <MemorySection
        title="当前会话摘要"
        subtitle="本会话的滚动摘要:目标、已定决策、关键事实。"
        emptyHint="无活动会话——打开一个会话后可在这里查看/编辑它的摘要。"
        scope={{ level: 'session', wsPath, sessionId }}
        active={!!(wsPath && sessionId)}
      />
    </div>
  )
}
