import { useCallback, useEffect, useRef, useState } from 'react'
import type { Pet, PetState, ResolvePayload, WorkspaceMeta, PetStateConfig, ChatQueueEvent, SessionsFile } from '@shared/types'
import { useEngine } from '../state/useEngine'
import { derivePetState } from './derivePetState'
import { derivePetAction } from './derivePetAction'
import { derivePopupData } from './derivePopupData'
import { usePetToasts } from './usePetToasts'
import { usePetDrag } from './usePetDrag'
import { usePetResize } from './usePetResize'
import { petSpriteSize } from '@shared/petGeometry'
import { useChatActivity } from './useChatActivity'
import { PetWidget } from './PetWidget'
import { resolveActiveCustomPet, type CustomPet } from '@shared/petCustom'
import { PetPopup } from './PetPopup'
import { PetToasts } from './PetToasts'
import { PetBubble } from './PetBubble'
import { PetSimplePanel } from './PetSimplePanel'
import { deriveSimpleKind } from './deriveSimpleKind'
import { petTgt } from './petTarget'
import type { PetTarget } from './petTarget'
import { applyTheme } from '../theme/applyTheme'
import type { Appearance } from '@shared/types'

// pet.html hard-codes a data-theme. Without syncing the app's real appearance, the pet popup could
// diverge from the main window's theme. Mirror the main window's theme onto the pet document.
// Defaults cover a settings object that predates the appearance block (light = new-user default).
const DEFAULT_APPEARANCE: Appearance = { theme: 'light', accent: 'blue', vibrancy: true, glass: false, windowOpacity: 1, blurAmount: 0, density: 'comfortable', fontSize: 14, chatFontSize: 14, fontFamily: '', textWeight: 'medium', bgImage: '', bgScope: 'off', bgOpacity: 0.35, bgWallpaperId: '', homeBgImage: '', homeBgOn: false, homeBgOpacity: 0.35 }

const DEFAULT_NOTIFY: Pet['notify'] = { confirm: true, input: true, done: false }
const DEFAULT_STATES: Pet['states'] = {
  idle: { anim: 'float', accent: 'none' }, working: { anim: 'spin-halo', accent: 'none' },
  confirm: { anim: 'alert', accent: 'warn' }, input: { anim: 'tilt', accent: 'accent' }, done: { anim: 'pulse-ok', accent: 'ok' }
}
const DONE_REVERT_MS = 4000
const AGENT_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' }
const PET_TARGET_KEY = 'forge.pet.target'

function readStoredTarget(): PetTarget | null {
  try { const v = localStorage.getItem(PET_TARGET_KEY); return v ? (JSON.parse(v) as PetTarget) : null } catch { return null }
}
function writeStoredTarget(t: PetTarget | null) {
  try { if (t) localStorage.setItem(PET_TARGET_KEY, JSON.stringify(t)); else localStorage.removeItem(PET_TARGET_KEY) } catch { /* ignore */ }
}

export function PetApp() {
  const { run, pending } = useEngine()
  const [skin, setSkin] = useState<Pet['skin']>('sprite')
  const [corner, setCorner] = useState<Pet['corner']>('right')
  const [notify, setNotify] = useState<Pet['notify']>(DEFAULT_NOTIFY)
  const [states, setStates] = useState<Pet['states']>(DEFAULT_STATES)
  const [customImages, setCustomImages] = useState<Partial<Record<PetState, string>>>({})
  const [customEmoji, setCustomEmoji] = useState<Pet['customEmoji']>(undefined)
  const [customPets, setCustomPets] = useState<CustomPet[]>([])
  const [activeCustomPetId, setActiveCustomPetId] = useState<string | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [interactionMode, setInteractionMode] = useState<Pet['interactionMode']>('simple')
  // Simple-mode bubble collapse (chevron). Reset to expanded when a confirm/input request needs attention.
  const [simpleCollapsed, setSimpleCollapsed] = useState(true)
  const [vdir, setVdir] = useState<'up' | 'down'>('up')
  // Sprite scale (user-resizable via the hover handle). scaleRef mirrors the state for the long-lived
  // pointer handlers; `resizing` keeps the handle visible + ignore-mouse off while dragging it.
  const [scale, setScaleState] = useState(1)
  const scaleRef = useRef(1)
  const [resizing, setResizing] = useState(false)
  const resizingRef = useRef(false)
  // True for the whole press→release of a sprite drag. Dragging moves the window to chase the cursor
  // (one IPC per move), so the lagging window can slip out from under a fast cursor → mouseleave →
  // ignore-mouse ON → the OS stops delivering events → the drag freezes. This ref suppresses that,
  // exactly like resizingRef does for the resize handle.
  const draggingRef = useRef(false)
  const hoveredRef = useRef(false)
  // Hover as reactive state (the ref alone won't re-render) so the atlas pet can wave on hover.
  const [hovered, setHovered] = useState(false)
  const [workspaces, setWorkspaces] = useState<WorkspaceMeta[]>([])
  const [doneReverted, setDoneReverted] = useState(false)
  const [queues, setQueues] = useState<Record<string, ChatQueueEvent['queue']>>({})
  const [runningByWs, setRunningByWs] = useState<Record<string, { id: string; text: string; sessionId: string } | null>>({})
  const [busyWs, setBusyWs] = useState<Set<string>>(new Set())
  const [cmdText, setCmdText] = useState('')
  const [sessionsByWs, setSessionsByWs] = useState<Record<string, SessionsFile>>({})
  const [petTarget, setPetTargetState] = useState<PetTarget | null>(() => readStoredTarget())
  const setPetTarget = useCallback((t: PetTarget | null) => { writeStoredTarget(t); setPetTargetState(t) }, [])
  const { toasts, dismiss } = usePetToasts(notify)
  const chatActivity = useChatActivity()
  // The workspace the main window is "in" (null on home), relayed from the main renderer. When set, it is
  // the command target; on home the user click-selects one in the pet's own list (selectedWs).
  const [mainActiveWs, setMainActiveWs] = useState<string | null>(null)
  const [selectedWs, setSelectedWs] = useState<string>('')
  useEffect(() => {
    const off = window.forge.onActiveWorkspace?.(setMainActiveWs)
    return () => { off?.() }
  }, [])
  // Priority: the workspace the main window is in → a workspace the user click-picked on home → the live
  // run's workspace (so a running workspace stays interactive even when the main window is on home).
  const currentWs = mainActiveWs || selectedWs || (run?.workspacePath ?? '')
  // Resolve explicit petTarget → fallback to currentWs active session.
  const tgtRaw = petTgt(petTarget, sessionsByWs, currentWs)
  // Build the tgt prop for PetPopup: enrich ws with name from WorkspaceMeta list.
  const tgtWsMeta = workspaces.find(w => w.path === tgtRaw.wsPath) ?? null
  const tgtSessFile = tgtRaw.wsPath ? sessionsByWs[tgtRaw.wsPath] : undefined
  const tgt = {
    wsPath: tgtRaw.wsPath,
    ws: tgtWsMeta ? { name: tgtWsMeta.name, status: tgtWsMeta.status, activeSessionId: tgtSessFile?.activeSessionId } : null,
    sess: tgtRaw.sess,
  }
  const tgtWsRunning = !!(tgtWsMeta?.status === 'run' || busyWs.has(tgtRaw.wsPath))
  // Sessions for the target workspace — displayed in the inline sessbar
  const sessionsForTarget = tgtRaw.ws?.sessions ?? []
  // View state for pet popup: 'main' = normal view, 'pick' = session picker drawer
  const [petView, setPetView] = useState<'main' | 'pick'>('main')

  const apply = (s: any) => {
    applyTheme({ ...DEFAULT_APPEARANCE, ...(s?.appearance ?? {}) })
    setSkin(s?.pet?.skin ?? 'sprite'); setCorner(s?.pet?.corner ?? 'right')
    setInteractionMode(s?.pet?.interactionMode ?? 'simple')
    setNotify(s?.pet?.notify ?? DEFAULT_NOTIFY); setStates(s?.pet?.states ?? DEFAULT_STATES)
    setCustomImages(s?.pet?.customImages ?? {})
    setCustomEmoji(s?.pet?.customEmoji ?? undefined)
    setCustomPets(s?.pet?.customPets ?? [])
    setActiveCustomPetId(s?.pet?.activeCustomPetId ?? undefined)
    // Don't clobber the live value mid-resize (a settings broadcast can land between live updates).
    if (!resizingRef.current) { const sc = s?.pet?.scale ?? 1; scaleRef.current = sc; setScaleState(sc) }
  }
  useEffect(() => {
    window.forge.getSettings().then(apply).catch(() => apply(null))
    const off = window.forge.onSettingsChanged(apply)
    return () => { off() }
  }, [])

  useEffect(() => {
    const off = window.forge.onSessionsChanged?.((raw: unknown) => {
      const p = raw as { workspacePath: string; file: SessionsFile }
      setSessionsByWs(prev => ({ ...prev, [p.workspacePath]: p.file }))
    })
    return () => { off?.() }
  }, [])

  useEffect(() => {
    const off = window.forge.onChatQueueEvent((e: ChatQueueEvent) => {
      setQueues(prev => ({ ...prev, [e.workspacePath]: e.queue }))
      setRunningByWs(prev => ({ ...prev, [e.workspacePath]: e.running ?? null }))
      // Track which workspaces have a chat turn in flight so the popup dot can light up live.
      setBusyWs(prev => {
        if (e.busy === prev.has(e.workspacePath)) return prev
        const n = new Set(prev)
        if (e.busy) n.add(e.workspacePath); else n.delete(e.workspacePath)
        return n
      })
    })
    return () => { off() }
  }, [])
  // tgtWs is the workspace the pet actually sends to — the SAME one we show queue/running/cancel/stop for.
  // When no explicit petTarget is set, tgtRaw.wsPath falls back to currentWs, preserving existing behavior.
  const tgtWs = tgtRaw.wsPath || currentWs
  const queue = tgtWs ? (queues[tgtWs] ?? []) : []
  // Note: `running` may briefly show while activeCancel is being re-registered between turns (the
  // chatQueue stop/registerActive window is not atomic). This is cosmetic-only and does not affect correctness.
  const running = tgtWs ? (runningByWs[tgtWs] ?? null) : null

  const onSendCmd = async (text: string) => {
    const t = tgt
    if (!t?.wsPath) return
    // Prefer the live run's first agent (real provider+model). When the target is idle (no run, or a
    // different workspace than the run), fall back to the workspace's first configured stage so non-claude
    // workspaces still get the right provider+model — never hardcode a single model.
    let provider = 'claude'
    let model = 'opus-4.8'
    const liveAgent = run && run.workspacePath === t.wsPath ? run.stages.flatMap(s => s.agents)[0] : null
    if (liveAgent) {
      provider = liveAgent.provider ?? provider
      model = liveAgent.model ?? model
    } else {
      try {
        const ws = await window.forge.getWorkspace(t.wsPath)
        const st0 = ws?.stages?.[0]
        if (st0?.provider) provider = st0.provider
        if (st0?.model) model = st0.model
      } catch { /* keep defaults */ }
    }
    const agentLabel = AGENT_LABEL[provider] ?? provider
    // Route to the specifically selected session — switch to it first so the main window tracks the same
    // session the command is being sent to.
    let sessionId: string
    if (t.sess) {
      sessionId = t.sess.id
      await window.forge.sessionSwitch({ workspacePath: t.wsPath, sessionId })
    } else {
      // No session resolved yet (sessions data not yet loaded) — fall back to the active session id
      // from a fresh sessionList call, same as the legacy behaviour.
      sessionId = 'default'
      try { const sf = await window.forge.sessionList(t.wsPath); if (sf?.activeSessionId) sessionId = sf.activeSessionId } catch { /* keep default */ }
    }
    window.forge.sendChat({ workspacePath: t.wsPath, sessionId, agent: provider, agentLabel, model, text, attachments: [] }, '宠物')
    // Bring the main window to this workspace so the user can watch the reply stream in.
    window.forge.petFocusWorkspace(t.wsPath)
  }
  const onCancelCmd = (id: string) => {
    window.forge.chatCancelQueued({ workspacePath: tgtWs, id })
  }
  const onStop = () => {
    if (!running || !tgtWs) return
    // Session-scoped stop: kill only the lane the pet is watching (running.sessionId), not every lane
    // in the workspace — mirrors the composer's per-session 停止. A workspace-wide stop here used to
    // also cancel a concurrent session B's turn the user never touched.
    window.forge.chatStop({ workspacePath: tgtWs, sessionId: running.sessionId })
  }

  // Pick a specific session as the send target; always return to main view (M3 fix, prototype line 7214)
  const onPickSess = useCallback((wsPath: string, sessId: string) => {
    setPetTarget({ wsPath, sessId })
    setPetView('main')
  }, [setPetTarget])

  // Jump to the target session in the main window without sending
  const onJump = async () => {
    if (!tgt?.ws || !tgt.sess) return
    await window.forge.sessionSwitch({ workspacePath: tgt.wsPath, sessionId: tgt.sess.id })
    window.forge.petFocusWorkspace(tgt.wsPath)
    closePop()
  }

  const rawState = derivePetState(run, pending, chatActivity)
  const state = rawState === 'done' && doneReverted ? 'idle' : rawState
  // Codex atlas action (9-row) — separate from the 5-state legacy `state`. Hover greets an idle pet.
  const petAction = derivePetAction(run, pending, chatActivity, { hovered })
  // Look-at-cursor heading pushed from the main process (null in the deadzone); applied only while idle.
  const [lookDeg, setLookDeg] = useState<number | null>(null)
  useEffect(() => {
    const off = window.forge.onPetLookAngle?.(setLookDeg)
    return () => { off?.() }
  }, [])
  // done → idle revert timer
  useEffect(() => {
    if (rawState !== 'done') { setDoneReverted(false); return }
    setDoneReverted(false)
    const t = setTimeout(() => setDoneReverted(true), DONE_REVERT_MS)
    return () => clearTimeout(t)
  }, [rawState, run?.id])

  const openPop = () => {
    setOpen(true)
    window.forge.listWorkspaces().then(wss => {
      setWorkspaces(wss)
    }).catch(() => setWorkspaces([]))
  }
  const closePop = () => setOpen(false)

  const loadSessionsFor = useCallback((paths: string[]) => {
    const missing = [...new Set(paths)].filter(path => path && !sessionsByWs[path])
    missing.forEach(path => {
      window.forge.sessionList(path).then((sf: SessionsFile) => {
        setSessionsByWs(prev => ({ ...prev, [path]: sf }))
      }).catch(() => { /* keep existing */ })
    })
  }, [sessionsByWs])

  useEffect(() => {
    const onBlur = () => { if (open) closePop() }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [open])

  const cfg: PetStateConfig = states[state] ?? DEFAULT_STATES[state]
  // Which custom pet to show: the selected entry of customPets, else the legacy singular custom fields.
  const resolvedCustom = resolveActiveCustomPet({ customPets, activeCustomPetId, customImages, customEmoji })
  const data = derivePopupData(run, pending, workspaces, busyWs)

  // ── Simple interaction mode ────────────────────────────────────────────────────────────────────
  const simple = interactionMode === 'simple'
  const simpleKind = simple ? deriveSimpleKind(state) : 'idle'
  const simplePanelShown = simpleKind !== 'idle'
  // A confirm/input request must be seen — auto-expand the bubble when one arrives.
  useEffect(() => {
    if (simpleKind === 'confirm' || simpleKind === 'input') setSimpleCollapsed(false)
  }, [simpleKind])
  const onSimpleJump = (path?: string) => window.forge.petFocusWorkspace(path ?? run?.workspacePath ?? currentWs ?? '')
  const runningWorkspaces = data.workspaces.filter(w => w.status === 'run').map(w => ({ name: w.name, path: w.path }))

  // The drag hook needs the live popup direction at drop time (the sprite sits at the window top in
  // 'down' mode), kept in a ref so the long-lived pointer handlers never read a stale value.
  const bubbleActive = data.activeAgents.length > 0 && !open && toasts.length === 0
  const petMode: 'collapsed' | 'bubble' | 'expanded' = simple
    ? (simplePanelShown ? (simpleCollapsed ? 'bubble' : 'expanded') : 'collapsed')
    : (open || toasts.length > 0) ? 'expanded' : bubbleActive ? 'bubble' : 'collapsed'
  const expanded = petMode !== 'collapsed'
  const stageVdir = expanded ? vdir : 'up'
  const vdirRef = useRef<'up' | 'down'>('up')
  vdirRef.current = stageVdir

  const drag = usePetDrag(({ corner: c, free }) => {
    // read-modify-write of the full settings object; acceptable for a single-user pet
    // (drops are seconds apart) — not serialized against a concurrent settings-panel write.
    // Persist the absolute free drop position + derived corner (for popup direction).
    window.forge.getSettings().then((s: any) => {
      if (!s?.pet) return
      window.forge.setSettings({ ...s, pet: { ...s.pet, corner: c, free } })
      setCorner(c)
    })
  }, () => vdirRef.current, () => scaleRef.current)

  // Resize handle drag, zero window re-bounds while live: `begin` (pointerdown) asks the main process
  // ONCE to pre-grow the window to the max-scale footprint (sprite anchor held — it is CSS-anchored to
  // the corner/vdir edges, which the grow keeps fixed); every live move then only updates the --pet-size
  // CSS var (pure CSS scaling — re-bounding per move fought the render and jittered); commit sends one
  // petSetScale (clamp + persist + dockPet back around the final size). petSetScale returns the
  // (possibly re-picked) popup direction, mirroring petSetExpanded. Even a no-op commit (scale
  // unchanged) re-docks, collapsing the pre-grown footprint back.
  const beginResize = useCallback(() => {
    resizingRef.current = true
    setResizing(true)
    Promise.resolve(window.forge.petResizeBegin?.()).catch(() => {})
  }, [])
  const applyScale = useCallback((sc: number, phase: 'live' | 'commit') => {
    scaleRef.current = sc
    setScaleState(sc)
    if (phase === 'live') return // live = CSS var only, no IPC
    resizingRef.current = false
    setResizing(false)
    // pointerup outside the window (common when shrinking): mouseleave already fired during the
    // resize and was suppressed, and it won't re-fire — restore click-through explicitly on commit.
    if (!hoveredRef.current) window.forge.petSetIgnoreMouse(true)
    Promise.resolve(window.forge.petSetScale?.(sc))
      .then((v: unknown) => { if (v === 'up' || v === 'down') setVdir(v) })
      .catch(() => {})
  }, [])
  const resize = usePetResize(() => scaleRef.current, applyScale, beginResize)
  const toggle = () => {
    if (drag.isDragging() || resize.isResizing()) return
    // Simple mode: clicking the pet BODY always brings the app forward and jumps to the running
    // workspace/session — it's the natural "take me there" gesture. Collapsing/expanding the status
    // panel is the dedicated chevron's job (.ps-collapse), not the whole sprite's.
    if (simple) {
      window.forge.petFocusWorkspace(run?.workspacePath ?? currentWs ?? '')
      return
    }
    open ? closePop() : openPop()
  }

  // Keep ignore-mouse OFF for the entire press so a lagging window-follow can't kill the drag (see
  // draggingRef). On release, restore click-through if the cursor ended up off the pet (mouseleave was
  // suppressed during the drag and won't re-fire — same reasoning as the resize commit).
  const onHitPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    draggingRef.current = true
    const onUp = () => {
      window.removeEventListener('pointerup', onUp)
      draggingRef.current = false
      if (!hoveredRef.current) window.forge.petSetIgnoreMouse(true)
    }
    window.addEventListener('pointerup', onUp)
    void drag.onPointerDown(e)
  }

  // Resize the window to fit the popup. The main process keeps the SPRITE fixed and returns which way
  // the popup opened (up/down) so the CSS anchors the sprite + popup to match — the sprite never jumps.
  useEffect(() => {
    Promise.resolve(window.forge.petSetExpanded(petMode))
      .then((v: any) => { if (v === 'up' || v === 'down') setVdir(v) })
      .catch(() => {})
  }, [petMode])

  // Legacy engine-bus pending actions are gone (run always null here), so this never fires with a real
  // pending; kept as an inert prop for PetPopup/PendingActionCard. run2/chat gates resolve elsewhere.
  const onResolve = (_p: ResolvePayload) => {}
  const onGo = (path: string) => { window.forge.petFocusWorkspace(path); closePop() }
  const onToastView = (id: string) => { dismiss(id); openPop() }

  // stageVdir (computed above) applies the popup direction only while expanded; collapsed the sprite
  // always rests bottom-anchored.
  return (
    <div className={`pet-stage${resizing ? ' pet-resizing' : ''}`} data-corner={corner} data-vdir={stageVdir} data-mode={petMode}
      style={{ '--pet-size': `${petSpriteSize(scale)}px` } as React.CSSProperties}
      onMouseEnter={() => { hoveredRef.current = true; setHovered(true); window.forge.petSetIgnoreMouse(false) }}
      onMouseLeave={() => { hoveredRef.current = false; setHovered(false); if (!resizingRef.current && !draggingRef.current) window.forge.petSetIgnoreMouse(true) }}>
      <button className="pet-hit" aria-label="助手宠物" onPointerDown={onHitPointerDown} onClick={toggle}
        onContextMenu={(e) => { e.preventDefault(); window.forge.petContextMenu() }}>
        <PetWidget skin={skin} anim={cfg.anim} accent={cfg.accent} state={state}
          customImages={resolvedCustom.images} customEmoji={resolvedCustom.emoji}
          atlas={resolvedCustom.atlas} action={petAction}
          lookDeg={petAction === 'idle' ? lookDeg : undefined} />
        {/* Simple mode surfaces status through the bubble, not a count badge. */}
        <span className={`pet-badge${!simple && data.badge ? ' show' : ''}${data.badge?.warn ? ' warn' : ''}`}>{simple ? '' : (data.badge?.count ?? '')}</span>
        {/* 缩放手柄:hover 显示,按住拖动连续放大/缩小(codex 桌宠样式)。button 内不能再嵌 button,
            用 span[role=button];pointerdown/click 都 stopPropagation,避免触发拖拽/点击展开。 */}
        <span className="pet-resize" role="button" aria-label="调整宠物大小" title="拖动调整大小"
          onPointerDown={(e) => { e.stopPropagation(); resize.onPointerDown(e) }}
          onClick={(e) => e.stopPropagation()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 8l8 8" /><path d="M16 10v6h-6" /><path d="M8 14V8h6" />
          </svg>
        </span>
      </button>
      {simple ? (
        <PetSimplePanel
          kind={simpleKind}
          runningWorkspaces={runningWorkspaces}
          pending={data.pending}
          corner={corner}
          collapsed={simpleCollapsed}
          onToggleCollapse={() => setSimpleCollapsed(c => !c)}
          onResolve={onResolve}
          onJump={onSimpleJump}
        />
      ) : (
        <>
          <PetPopup open={open} corner={corner} data={data} onResolve={onResolve} onGo={onGo} onClose={closePop}
            queue={queue} currentWs={currentWs} onSendCmd={onSendCmd} onCancelCmd={onCancelCmd}
            selectable={!mainActiveWs} onSelectWs={setSelectedWs}
            tgt={tgt} sessionsForTarget={sessionsForTarget} onPickSess={onPickSess}
            onOpenPicker={() => {
              setPetView('pick')
              loadSessionsFor([tgtRaw.wsPath, ...workspaces.map(ws => ws.path)])
            }} onJump={onJump}
            petView={petView} tgtWsRunning={tgtWsRunning}
            sessionsByWs={sessionsByWs} onPickerBack={() => setPetView('main')}
            workspaces={workspaces}
            cmd={cmdText} onCmdChange={setCmdText}
            running={running} onStop={onStop} />

          <PetToasts toasts={toasts} corner={corner} onView={onToastView} onDismiss={dismiss} />
          {bubbleActive && (
            <PetBubble active={data.activeAgents} seed={run?.id ?? (data.activeAgents[0]?.name ?? '')} corner={corner} onOpen={openPop} />
          )}
        </>
      )}
    </div>
  )
}
