// 对话页(08 §7;08b §4.3):左边会话列(SessionColumn),右边是选中的会话(SessionPane:各轮的内容 + 输入框)或新会话表单。
// 主区窄于 LIST_NARROW_BELOW 时会话列变窄;量不到宽度(jsdom)按宽处理(R4)。
// 选中、新会话、去合并都经 route。改名、发送重试时用同一个 commandId(超时后的重试才有回执重放)。
// 页顶的习惯推荐卡片(08 §12.4)和对话本身无关,单独一个组件,纯事件驱动。
import { useRef, useState } from 'react'
import type { SessionSummary } from '@mffai/protocol'
import { call, cmd, retryable } from '../rpc'
import { useMffaiEvent } from '../events'
import { route } from '../route'
import { useRoute } from '../useRoute'
import { DeleteSources } from '../ui/DeleteSources'
import { RecommendationCard } from '../memory/RecommendationCard'
import { useSessions } from './useSessions'
import { SessionColumn } from './SessionColumn'
import { useMainWidth } from '../useMainWidth'
import { LIST_NARROW_BELOW } from '../layout'
import { NewSession } from './NewSession'
import { SessionPane } from './SessionPane'
import { DeleteSession } from './DeleteSession'

const K = '\u0000'

export default function ChatPage() {
  const r = useRoute()
  const { sessions, imNames, reload, unsupported } = useSessions()
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [notes, setNotes] = useState<string[] | null>(null)
  const renameCmd = useRef(retryable()).current
  const sendCmd = useRef(retryable()).current
  const width = useMainWidth()
  const narrow = width !== undefined && width < LIST_NARROW_BELOW

  const activeId = r.newSession ? undefined : r.sessionId
  const active = activeId ? sessions.find((s) => s.id === activeId) : undefined

  useMffaiEvent({ types: ['session.deleted'] }, (e) => {
    if (e.sessionId && e.sessionId === route.get().sessionId) route.set({ page: 'chat' })
  })

  const rename = async (sessionId: string, title: string): Promise<boolean> => {
    const key = sessionId + K + title
    try {
      await call('session.rename', { commandId: renameCmd.id(key), sessionId, title })
      renameCmd.done(key)
      reload()
      return true
    } catch (e) {
      console.error('mffai session.rename', e)
      return false
    }
  }

  const send = async (sessionId: string, key: string, run: (commandId: string) => Promise<unknown>) => {
    await run(sendCmd.id(sessionId + K + key))
    sendCmd.done(sessionId + K + key)
  }

  return (
    <div className="mffai-pane mffai-chatroot">
      <div className="mffai-chat">
        <SessionColumn sessions={sessions} active={activeId} imNames={imNames} unsupported={unsupported} narrow={narrow}
          onNew={() => route.set({ page: 'chat', newSession: {} })}
          onSelect={(id) => route.set({ page: 'chat', sessionId: id })}
          onRename={rename} onDelete={setDeleting} />
        <section className={`mffai-chat-main${activeId ? '' : ' mffai-chat-new'}`}>
          <RecommendationCard />
          {activeId ? (
            <SessionPane
              key={activeId}
              sessionId={activeId}
              summary={active}
              imName={imNames.get(activeId)}
              onSend={(text) => send(activeId, text, (commandId) => call('session.prompt', { commandId, sessionId: activeId, text }))}
              onCommand={(name, args) => send(activeId, `/${name}${K}${args}`, (commandId) => call('plugins.command.run', { commandId, sessionId: activeId, name, args }))}
              onStop={() => { void call('session.cancel', { commandId: cmd(), sessionId: activeId }).catch((e) => console.error('mffai session.cancel', e)) }}
            />
          ) : (
            <NewSession key={JSON.stringify(r.newSession ?? null)} initial={r.newSession}
              onCreated={(id) => { reload(); route.set({ page: 'chat', sessionId: id }) }} />
          )}
        </section>
        {deleting && (
          <DeleteSession session={deleting} onClose={() => setDeleting(null)}
            onDeleted={(n) => {
              const id = deleting.id
              setDeleting(null)
              if (route.get().sessionId === id) route.set({ page: 'chat' })
              reload()
              if (n.length) setNotes(n)
            }} />
        )}
        {notes && <DeleteSources title={(n) => `仍引用它的记忆 ${n} 条`} ids={notes} onClose={() => setNotes(null)} />}
      </div>
    </div>
  )
}
