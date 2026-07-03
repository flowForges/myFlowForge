import { useState, type ReactElement } from 'react'
import type { Pet, ResolvePayload, ChatSession, SessionsFile, WorkspaceMeta } from '@shared/types'
import type { PopupData } from './derivePopupData'
import { PendingActionCard } from './PendingActionCard'
import { WorkspaceRow } from './WorkspaceRow'
import { sessLabel } from './petTarget'

const AV: ReactElement = (
  <svg className="av" viewBox="0 0 64 64" aria-hidden="true">
    <path d="M32 8c13 0 21 8.5 21 23 0 15-8.5 25-21 25S11 46 11 31C11 16.5 19 8 32 8Z" fill="var(--accent)" />
    <circle cx="24.5" cy="30" r="4" fill="#0b1020" />
    <circle cx="39.5" cy="30" r="4" fill="#0b1020" />
  </svg>
)

function modeLabel(m: string | undefined): string {
  return m === 'workflow' ? '工作流' : '对话'
}

// Shape of tgt as passed in from PetApp.
// ws carries name (from WorkspaceMeta) for display; sessions live in sessionsForTarget.
type TgtProp = {
  wsPath: string
  ws: { name: string; status?: string; activeSessionId?: string } | null
  sess: ChatSession | null
} | null

function dotClass(s: string | undefined): string {
  return s === 'run' ? 'run' : s === 'ok' ? 'ok' : 'idle'
}

export function PetPopup({ open, corner, data, onResolve, onGo, onClose, queue, currentWs, onSendCmd, onCancelCmd, selectable, onSelectWs, tgt, sessionsForTarget, onPickSess, onOpenPicker, onJump, petView, tgtWsRunning, sessionsByWs, onPickerBack, workspaces, cmd: cmdProp, onCmdChange, running, onStop }: {
  open: boolean
  corner: Pet['corner']
  data: PopupData
  onResolve: (p: ResolvePayload) => void
  onGo: (path: string) => void
  onClose: () => void
  queue?: { id: string; text: string; source: string }[]
  currentWs?: string
  onSendCmd?: (text: string) => void
  onCancelCmd?: (id: string) => void
  selectable?: boolean
  onSelectWs?: (path: string) => void
  tgt?: TgtProp
  sessionsForTarget?: ChatSession[]
  onPickSess?: (wsPath: string, sessId: string) => void
  onOpenPicker?: () => void
  onJump?: () => void
  petView?: 'main' | 'pick'
  /** Whether the target workspace is currently running (used to show .sd.run on the active session chip) */
  tgtWsRunning?: boolean
  /** All workspaces' sessions — used by the picker drawer to list all ws+session options */
  sessionsByWs?: Record<string, SessionsFile>
  /** Called when the user taps the back button in the picker drawer */
  onPickerBack?: () => void
  /** All workspaces metadata — used to resolve real names/status in the picker drawer */
  workspaces?: WorkspaceMeta[]
  /** Controlled input value — lifted to PetApp so cancel/terminate can restore the text */
  cmd?: string
  /** Called when the input value should change */
  onCmdChange?: (text: string) => void
  /** Currently running chat item for currentWs (null when idle) */
  running?: { id: string; text: string } | null
  /** Called when the user clicks 终止 */
  onStop?: () => void
}) {
  // Support both controlled (cmdProp/onCmdChange) and uncontrolled (local state) usage for backwards compat
  const [localCmd, setLocalCmd] = useState('')
  const cmd = cmdProp !== undefined ? cmdProp : localCmd
  const setCmd = (v: string) => {
    if (cmdProp !== undefined) { onCmdChange?.(v) } else { setLocalCmd(v) }
  }
  const send = () => {
    const t = cmd.trim()
    if (!t) return
    onSendCmd?.(t)
    setCmd('')
  }

  // Show the new target-aware footer only when the caller passes tgt with a non-empty wsPath.
  // When wsPath is empty (home screen, no workspace selected yet) fall back to the legacy disabled input.
  const hasTgt = !!(tgt?.wsPath)

  // ── Picker drawer (petView === 'pick') ──────────────────────────────────────
  if (petView === 'pick') {
    // Sort workspaces: run → ok → idle (same as prototype line 7091-7092)
    const ORDER: Record<string, number> = { run: 0, ok: 1, idle: 2 }
    const allWsPaths = Object.keys(sessionsByWs ?? {})
    const sortedPaths = allWsPaths.slice().sort((a, b) => {
      const metaA = workspaces?.find(m => m.path === a)
      const metaB = workspaces?.find(m => m.path === b)
      const s1 = (a === tgt?.wsPath ? tgt?.ws?.status : metaA?.status) ?? 'idle'
      const s2 = (b === tgt?.wsPath ? tgt?.ws?.status : metaB?.status) ?? 'idle'
      return (ORDER[s1] ?? 3) - (ORDER[s2] ?? 3)
    })

    return (
      <div className={`pet-pop${open ? ' open' : ''}`} data-corner={corner}>
        <div className="pet-pop-head">
          {AV}
          <div><div className="tt">Forge 助手</div><div className="st">{data.statusText}</div></div>
          <button className="pp-x" aria-label="关闭" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <div className="pet-pop-body">
          <button className="pp-back" onClick={onPickerBack}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
            选择发送目标
          </button>
          <div className="pp-pickhint">指令会发送到所选会话的主代理。单会话工作区只有一行,多会话的会展开。</div>
          {sortedPaths.map(wsPath => {
            const sf = sessionsByWs?.[wsPath]
            if (!sf) return null
            const sessions = sf.sessions
            const isThisTgtWs = wsPath === tgt?.wsPath
            const wsMeta = workspaces?.find(m => m.path === wsPath)
            const wsStatus = isThisTgtWs ? (tgt?.ws?.status ?? wsMeta?.status ?? 'idle') : (wsMeta?.status ?? 'idle')
            const wsName = isThisTgtWs
              ? (tgt?.ws?.name ?? wsMeta?.name ?? wsPath.split('/').filter(Boolean).at(-1) ?? wsPath)
              : (wsMeta?.name ?? wsPath.split('/').filter(Boolean).at(-1) ?? wsPath)
            const wsRunning = isThisTgtWs ? !!tgtWsRunning : false
            const activeSessionId = isThisTgtWs ? tgt?.ws?.activeSessionId : sf.activeSessionId
            return (
              <div key={wsPath}>
                <div className="pk-ws">
                  <span className={`pd ${dotClass(wsStatus)}`}></span>
                  <span className="pk-wn">{wsName}</span>
                  {sessions.length > 1 && <span className="pk-c">{sessions.length} 会话</span>}
                  {wsRunning && <span className="pk-run">代理在执行</span>}
                </div>
                {sessions.map(s => {
                  const on = isThisTgtWs && tgt?.sess?.id === s.id
                  const running = wsRunning && s.id === activeSessionId
                  return (
                    <button
                      key={s.id}
                      className={`pk-sess${on ? ' on' : ''}`}
                      onClick={() => onPickSess?.(wsPath, s.id)}
                    >
                      <span className={`sd ${running ? 'run' : s.mode}`}></span>
                      <span className="pk-st">{sessLabel(sessions, s)}</span>
                      {running && <span className="pk-live">运行中</span>}
                      <span className={`pk-mb ${s.mode}`}>{modeLabel(s.mode)}</span>
                      {on && (
                        <svg className="pk-ck" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
        {/* Footer is intentionally empty in pick view (prototype line 7115) */}
      </div>
    )
  }

  // ── Normal (main) view ──────────────────────────────────────────────────────
  return (
    <div className={`pet-pop${open ? ' open' : ''}`} data-corner={corner}>
      <div className="pet-pop-head">
        {AV}
        <div><div className="tt">Forge 助手</div><div className="st">{data.statusText}</div></div>
        <button className="pp-x" aria-label="关闭" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>
      <div className="pet-pop-body">
        {data.pending.length > 0 && (
          <>
            <div className="pp-sec">待你处理</div>
            {data.pending.map(p => <PendingActionCard key={p.id} action={p} onResolve={onResolve} />)}
          </>
        )}

        {data.activeAgents.length > 0 && (
          <>
            <div className="pp-sec">当前执行 · {data.activeAgents.length} 个代理</div>
            {data.activeAgents.map((a, i) => (
              <div key={i} className="pp-agent" title={`${a.name}${a.role ? ' · ' + a.role : ''} · ${a.stage}`}>
                <span className="pa-dot" />
                <span className="pa-name">{a.name}</span>
                {a.role && <span className="pa-role">{a.role}</span>}
                <span className="pa-stage">{a.stage}</span>
              </div>
            ))}
          </>
        )}

        {running && (
          <div className="pp-q pp-running">
            <span className="qo">▶</span>
            <span className="qt">{running.text}</span>
            <button className="pp-stop" title="终止" onClick={() => { setCmd(running.text); onStop?.() }}>终止</button>
          </div>
        )}

        {queue && queue.length > 0 && (
          <>
            <div className="pp-sec">指令队列 · {queue.length} · 排队中</div>
            {queue.map((it, i) => (
              <div key={it.id} className="pp-q">
                <span className="qo">{i + 1}</span>
                <span className="qt">{it.text}</span>
                {it.source !== '你' && <span className="qsrc">{it.source}</span>}
                <button className="qx" title="取消" onClick={() => { setCmd(it.text); onCancelCmd?.(it.id) }}>×</button>
              </div>
            ))}
          </>
        )}
        <div className="pp-sec">工作区 · {data.workspaces.length}</div>
        {data.workspaces.length > 0
          ? data.workspaces.map(w => {
              const sc = sessionsByWs?.[w.path]?.sessions?.length ?? 0
              return (
                <WorkspaceRow key={w.path} ws={w} onGo={onGo}
                  selectable={selectable} selected={selectable && w.path === currentWs} onSelect={onSelectWs}
                  sessionCount={sc} onOpenPicker={onOpenPicker} />
              )
            })
          : <div className="pp-empty">暂无工作区</div>}
      </div>

      {/* Footer — pinned at the bottom (prototype line 2253: 固定在面板底部,永不被滚动裁切) */}
      <div className="pet-pop-foot">
        {/* Section header: new target-aware or legacy */}
        <div className="pp-sec">
          {hasTgt ? '下达指令 · 选择会话' : '向当前工作区下达指令'}
        </div>

        {/* Task 7: Target row — only shown when a workspace is resolved */}
        {hasTgt && (
          <div className="pp-target">
            <button className="tg-pick" onClick={onOpenPicker}>
              <span className="tg-l">发往</span>
              <span className={`pd ${dotClass(tgt!.ws?.status)}`}></span>
              <span className="tg-ws">{tgt!.ws ? tgt!.ws.name : (tgt!.wsPath.split('/').filter(Boolean).at(-1) ?? tgt!.wsPath)}</span>
              <span className="tg-sep">›</span>
              <span className="tg-sess">
                {tgt!.sess
                  ? sessLabel(sessionsForTarget ?? [], tgt!.sess)
                  : '—'}
              </span>
              {tgt!.sess && (
                <span className={`tg-mode ${tgt!.sess.mode}`}>
                  {modeLabel(tgt!.sess.mode)}
                </span>
              )}
              <svg className="tg-ca" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {tgt!.ws && tgt!.sess && (
              <button className="tg-jump" title="切到该会话的对话" onClick={onJump}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 18l6-6-6-6" />
                  <line x1="3" y1="12" x2="15" y2="12" />
                </svg>
              </button>
            )}
          </div>
        )}

        {/* Inline session bar — shown when there are sessions for the target workspace */}
        {hasTgt && tgt!.ws && (sessionsForTarget ?? []).length > 0 && (
          <div className="pp-sessbar">
            {(sessionsForTarget ?? []).map(s => {
              const on = tgt!.sess?.id === s.id
              const isActiveRunning = !!(tgtWsRunning && s.id === tgt!.ws?.activeSessionId)
              return (
                <button
                  key={s.id}
                  className={`ps-chip${on ? ' on' : ''}`}
                  title={sessLabel(sessionsForTarget ?? [], s)}
                  onClick={() => onPickSess?.(tgt!.wsPath, s.id)}
                >
                  <span className={`sd ${isActiveRunning ? 'run' : s.mode}`}></span>
                  <span className="ps-t">{sessLabel(sessionsForTarget ?? [], s)}</span>
                  {on && (
                    <svg className="ps-ck" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              )
            })}
            <button className="ps-more" title="切换到其它工作区的会话" onClick={onOpenPicker}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="5" cy="12" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="19" cy="12" r="1.6" />
              </svg>
              其它
            </button>
          </div>
        )}

        {/* Send input — stable DOM node; now in the pinned footer */}
        <div className="pp-send">
          <input
            type="text"
            placeholder={
              hasTgt
                ? '输入指令,发给选中的会话…'
                : (currentWs ? '输入指令,排队发给主代理…' : '先在下方点选一个工作区…')
            }
            value={cmd}
            disabled={!hasTgt && !currentWs}
            onChange={e => setCmd(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') send() }}
          />
          <button onClick={send} disabled={!hasTgt && !currentWs}>发送</button>
        </div>
      </div>
    </div>
  )
}
