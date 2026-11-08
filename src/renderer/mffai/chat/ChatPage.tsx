// 对话页(08 §7):左栏会话列表 + 新会话,右边是选中的会话(Task 7 在输入框上面放这一轮的内容)或新会话表单。
// 选中、新会话、去合并都经 route。改名、发送重试时用同一个 commandId(超时后的重试才有回执重放)。
import { useRef, useState } from 'react'
import type { SessionSummary } from '@mffai/protocol'
import { call, cmd, retryable } from '../rpc'
import { useMffaiEvent } from '../events'
import { route } from '../route'
import { useRoute } from '../useRoute'
import { Chip } from '../ui/Chip'
import { DeleteSources } from '../ui/DeleteSources'
import { useSessions } from './useSessions'
import { SessionList } from './SessionList'
import { NewSession } from './NewSession'
import { MffaiComposer } from './MffaiComposer'
import { DeleteSession } from './DeleteSession'

const K = '\u0000'

export default function ChatPage() {
  const r = useRoute()
  const { sessions, imNames, reload, unsupported } = useSessions()
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [notes, setNotes] = useState<string[] | null>(null)
  const renameCmd = useRef(retryable()).current
  const sendCmd = useRef(retryable()).current

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
    <div className="mffai-pane mffai-chat">
      <aside className="mffai-chat-side">
        <button className="set-btn" onClick={() => route.set({ page: 'chat', newSession: {} })}>新会话</button>
        {unsupported
          ? <Chip>不支持</Chip>
          : <SessionList sessions={sessions} active={activeId} imNames={imNames}
              onSelect={(id) => route.set({ page: 'chat', sessionId: id })}
              onRename={rename} onDelete={setDeleting} />}
      </aside>
      <section className="mffai-chat-main">
        {activeId ? (
          <>
            <div className="mffai-chat-body" />
            <MffaiComposer
              key={activeId}
              session={active ?? { id: activeId, origin: 'app' }}
              imName={imNames.get(activeId)}
              canStop={!!active?.open}
              parked={active?.open?.parked ? {} : undefined}
              onSend={(text) => send(activeId, text, (commandId) => call('session.prompt', { commandId, sessionId: activeId, text }))}
              onCommand={(name, args) => send(activeId, `/${name}${K}${args}`, (commandId) => call('plugins.command.run', { commandId, sessionId: activeId, name, args }))}
              onStop={() => { void call('session.cancel', { commandId: cmd(), sessionId: activeId }).catch((e) => console.error('mffai session.cancel', e)) }}
            />
          </>
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
  )
}
