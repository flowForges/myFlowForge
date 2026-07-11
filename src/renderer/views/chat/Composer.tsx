import { useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, ProviderInfo } from '@shared/types'
import { getBuiltinProvider } from '@shared/providerCatalog'
import { PERMISSION_MODES, DEFAULT_PERMISSION_MODE, permissionModeLabel, providerSupportsPermissions, type PermissionMode } from '@shared/permissions'
import { isSlashQuery, mergeCommands, type MenuCommand } from './slashCommands'

// ---- module-level SVG consts (1:1 with the prototype markup) ----
const CHEV_DD = (
  <svg className="dd-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
)
const CHECK = (
  <svg className="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
)
const PAPERCLIP = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
)
const SHIELD = (
  <svg className="cb-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /></svg>
)
const SEND_ARROW = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></svg>
)
const FILE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
)
const X_ICON = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
)
const EXPAND_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
)
const STOP_ICON = (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
)
const COLLAPSE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
)

// Resolve logo bg/color/glyph from the shared provider catalog by provider id.
// Falls back to neutral values for any provider not in the catalog.
const FALLBACK_LOGO = { bg: 'oklch(70% .03 250 / .25)', color: 'var(--fg-2)', glyph: '◆' }
function logoFor(id: string): { bg: string; color: string; glyph: string } {
  const meta = getBuiltinProvider(id)
  if (!meta) return FALLBACK_LOGO
  return { bg: meta.brandBg, color: meta.brandColor, glyph: meta.glyph }
}

function fmtSize(bytes: number): string {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

const MAX_H = 180

interface Props {
  providers: ProviderInfo[]
  disabled: boolean
  busy?: boolean
  /** When true, the textarea and send button are disabled (read-only imported session). */
  readOnly?: boolean
  /** When true, the workspace is archived — render an unmistakable disabled (read-only) look. */
  archived?: boolean
  /** When true, a turn is currently running. Empty input shows a stop button; non-empty shows send (queue). */
  running?: boolean
  /** Called when the user clicks the stop button or presses Escape while running. */
  onStop?: () => void
  /** True once the running turn has produced assistant output. Stopping BEFORE any output restores the
      sent message to the box (edit/resend); stopping AFTER output does not (changes may be irreversible). */
  turnHasOutput?: boolean
  onSend: (m: { agent: string; agentLabel: string; model: string; text: string; attachments: Attachment[]; permissionMode: PermissionMode }) => void
  onPaste?: (f: { name: string; dataBase64: string }) => Promise<Attachment | null>
  // When set (with a fresh nonce), fills the textarea with a starter prompt (快捷指令 chips).
  seedText?: { text: string; nonce: number }
  /** 受控选中态：提供时 Composer 以它为准并通过 onSelectionChange 上报变化（概览跟随）。 */
  selection?: { agentId: string; modelId: string; permissionMode?: PermissionMode }
  onSelectionChange?: (s: { agentId: string; modelId: string; permissionMode: PermissionMode }) => void
  /** 本机扫描到的该 provider 的自定义命令/prompt + skills(经 IPC),与 Forge 内置命令一起进 "/" 菜单。 */
  dynamicCommands?: MenuCommand[]
  /** Picking a workflow entry from the "/" menu (MenuCommand.workflowId set) calls this instead of
      just filling the textarea with a template — see chooseSlash. */
  onPickWorkflow?: (workflowId: string) => void
}

export function Composer({ providers, disabled, busy, readOnly, archived, running, onStop, turnHasOutput, onSend, onPaste, seedText, selection, onSelectionChange, dynamicCommands, onPickWorkflow }: Props) {
  const [text, setText] = useState('')
  // The last message we sent, so stopping the turn BEFORE the AI produced any output restores it to the
  // box for editing/resending (the user would otherwise retype/copy it back). Once the AI has output —
  // and possibly executed irreversible changes — we don't restore. Also skip if the box isn't empty.
  const lastSentRef = useRef('')
  const handleStop = () => {
    onStop?.()
    if (!turnHasOutput && !text.trim() && lastSentRef.current) setText(lastSentRef.current)
  }
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [localAgentId, setLocalAgentId] = useState<string>('')
  const [localModelId, setLocalModelId] = useState<string>('')
  const [localPerm, setLocalPerm] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE)
  const controlled = selection !== undefined
  const agentId = controlled ? selection!.agentId : localAgentId
  const modelId = controlled ? selection!.modelId : localModelId
  const permissionMode = (controlled ? selection!.permissionMode : localPerm) ?? DEFAULT_PERMISSION_MODE
  const setAgentId = (id: string) => { if (controlled) onSelectionChange?.({ agentId: id, modelId, permissionMode }); else setLocalAgentId(id) }
  const setModelId = (id: string) => { if (controlled) onSelectionChange?.({ agentId, modelId: id, permissionMode }); else setLocalModelId(id) }
  const setPermissionMode = (m: PermissionMode) => { if (controlled) onSelectionChange?.({ agentId, modelId, permissionMode: m }); else setLocalPerm(m) }
  const [openMenu, setOpenMenu] = useState<'agent' | 'ver' | 'perm' | null>(null)
  // Slash-command menu: shown while typing a "/token" (before any space). slashSel = highlighted row;
  // slashDismissed lets Esc close it until the query changes.
  const [slashSel, setSlashSel] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [customModelMode, setCustomModelMode] = useState(false)
  const [customModelInput, setCustomModelInput] = useState('')
  const [expanded, setExpanded] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const slashPopRef = useRef<HTMLDivElement>(null)

  // Only installed providers are selectable (an uninstalled CLI can't run).
  const installedProviders = useMemo(() => providers.filter(p => p.installed), [providers])

  // Seed agent + its first model once providers arrive; keep selection valid as install state changes.
  // In controlled mode, the parent owns initial values — skip seeding.
  useEffect(() => {
    if (controlled) return
    if (!installedProviders.length) return
    if (localAgentId && installedProviders.some(p => p.id === localAgentId)) return
    const seed = installedProviders[0]
    setLocalAgentId(seed.id)
    setLocalModelId(seed.models[0]?.id ?? '')
  }, [installedProviders, localAgentId, controlled])

  // Close the open menu on an outside click (matches the prototype's document click handler).
  useEffect(() => {
    if (!openMenu) return
    function onDocClick(e: MouseEvent) {
      const t = e.target as Element | null
      if (t && t.closest('.menu')) return
      setOpenMenu(null)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [openMenu])

  const agent = useMemo(() => providers.find(p => p.id === agentId), [providers, agentId])
  const models = agent?.models ?? []
  const model = models.find(m => m.id === modelId)

  function chooseAgent(p: ProviderInfo) {
    const m = p.models[0]?.id ?? ''
    if (controlled) onSelectionChange?.({ agentId: p.id, modelId: m, permissionMode })
    else { setLocalAgentId(p.id); setLocalModelId(m) }
    setOpenMenu(null)
  }
  function chooseModel(id: string) {
    setModelId(id)
    setOpenMenu(null)
  }

  function openCustomModel() {
    setCustomModelMode(true)
    setCustomModelInput('')
  }

  function confirmCustomModel() {
    const v = customModelInput.trim()
    if (v) setModelId(v)
    setCustomModelMode(false)
    setCustomModelInput('')
    setOpenMenu(null)
  }

  function autosize() {
    const ta = taRef.current
    if (!ta) return
    if (expanded) {
      // Enlarged mode: a tall fixed editing area so long input is easy to read/edit.
      const big = Math.round((typeof window !== 'undefined' ? window.innerHeight : 800) * 0.55)
      ta.style.height = big + 'px'
      return
    }
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, MAX_H) + 'px'
  }

  // Re-apply sizing whenever the enlarge toggle flips.
  useEffect(() => { autosize() }, [expanded])

  // 快捷指令 chips seed the composer with a starter prompt; focus so the user can edit/send.
  useEffect(() => {
    if (!seedText) return
    setText(seedText.text)
    const ta = taRef.current
    if (ta) { ta.focus(); requestAnimationFrame(autosize) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedText?.nonce])

  function send() {
    const t = text.trim()
    if (!t || disabled || !agent) return
    onSend({ agent: agent.id, agentLabel: agent.displayName, model: modelId, text: t, attachments, permissionMode })
    lastSentRef.current = t
    setText('')
    setAttachments([])
    // Reset to natural single-row height (matches the prototype's `autosize()` after
    // clearing). A hardcoded MIN_H px is shorter than one line + padding, which forces
    // a stray scrollbar after sending.
    const ta = taRef.current
    if (ta) { if (expanded) autosize(); else ta.style.height = 'auto' }
  }

  // Slash-command dropdown (derived each render). Only while typing a "/token" and not dismissed.
  const slashCmds = (!disabled && !readOnly && !archived && isSlashQuery(text) && !slashDismissed)
    ? mergeCommands(agentId, text, dynamicCommands ?? [])
    : []
  const showSlash = slashCmds.length > 0
  const slashActive = showSlash ? Math.min(slashSel, slashCmds.length - 1) : 0
  function chooseSlash(c: MenuCommand) {
    // A workspace-workflow entry (Task 13): hand off to the parent instead of filling the (empty)
    // template verbatim — the parent seeds a workflow-scoped trigger phrase via its own seedText
    // plumbing (same mechanism as the 快捷指令 chips), so the user types the task and sends normally.
    if (c.workflowId) { setText(''); onPickWorkflow?.(c.workflowId) }
    else setText(c.template)
    setSlashDismissed(true)
    const ta = taRef.current
    if (ta) { ta.focus(); requestAnimationFrame(autosize) }
  }
  // Keep the highlighted slash row in view as ↑/↓ moves past the visible window.
  useEffect(() => {
    if (!showSlash) return
    try { slashPopRef.current?.querySelector('.slash-item.on')?.scrollIntoView({ block: 'nearest' }) } catch { /* jsdom / unsupported */ }
  }, [slashActive, showSlash])

  async function pickFiles() {
    const a = await window.forge.openFiles()
    if (a && a.length) setAttachments(prev => [...prev, ...a])
  }

  function removeAttach(idx: number) {
    setAttachments(prev => prev.filter((_, i) => i !== idx))
  }

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = e.clipboardData?.files
    if (!files || !files.length || !onPaste) return
    e.preventDefault()
    for (const file of Array.from(files)) {
      const dataBase64: string = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const res = String(reader.result)
          const i = res.indexOf('base64,')
          resolve(i >= 0 ? res.slice(i + 'base64,'.length) : res)
        }
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      const att = await onPaste({ name: file.name, dataBase64 })
      if (att) setAttachments(prev => [...prev, att])
    }
  }

  const logo = logoFor(agent?.id ?? '')

  return (
    <div className="composer-wrap">
      <div className={`composer${archived ? ' archived' : ''}`}>
        <div className="composer-attach" id="composerAttach">
          {attachments.map((a, i) => (
            <span className="attach-chip" key={a.path + '::' + i}>
              {FILE_ICON}
              {a.name} <span className="sz">{fmtSize(a.size)}</span>
              <button title="移除" onClick={() => removeAttach(i)}>{X_ICON}</button>
            </span>
          ))}
        </div>
        {showSlash && (
          <div className="slash-pop" role="listbox" aria-label="斜杠命令" ref={slashPopRef}>
            <div className="slash-hd">命令 · {agent?.displayName ?? agentId}</div>
            {slashCmds.map((c, i) => (
              <button
                key={c.cmd}
                type="button"
                role="option"
                aria-selected={i === slashActive}
                className={'slash-item' + (i === slashActive ? ' on' : '')}
                onMouseEnter={() => setSlashSel(i)}
                onMouseDown={e => { e.preventDefault(); chooseSlash(c) }}
              >
                <span className="slash-cmd">{c.cmd}</span>
                <span className="slash-title">
                  {c.title}
                  {c.kind !== 'forge' && <span className="slash-tag">{c.kind === 'skill' ? '技能' : '本机'}</span>}
                </span>
                <span className="slash-desc">{c.desc || '本机自定义命令'}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          id="composerInput"
          rows={1}
          placeholder={archived ? '工作区已归档，只能查看历史。恢复后才能继续会话。' : readOnly ? '只读会话 · 请点击上方「基于此历史继续」按钮开始新对话' : busy ? '当前任务执行中… 继续输入将排队,依次发送' : '给主代理下达任务…  ↩ 发送 · ⇧↩ 换行 · 可粘贴文件 / 截图'}
          value={text}
          disabled={disabled || readOnly}
          onChange={e => {
            const v = e.target.value
            setText(v); setSlashSel(0)
            if (!isSlashQuery(v)) setSlashDismissed(false)   // reset so a fresh "/" re-opens the menu
            autosize()
          }}
          onPaste={handlePaste}
          onKeyDown={e => {
            // Slash menu owns navigation keys while open.
            if (showSlash) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSel(s => Math.min(s + 1, slashCmds.length - 1)); return }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSel(s => Math.max(s - 1, 0)); return }
              if (e.key === 'Escape') { e.preventDefault(); setSlashDismissed(true); return }
              if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing && !e.shiftKey) {
                e.preventDefault(); chooseSlash(slashCmds[slashActive]); return
              }
            }
            if (e.key === 'Escape' && running) { e.preventDefault(); handleStop(); return }
            if (e.key !== 'Enter') return
            // Never send mid-IME-composition (Chinese/Japanese/etc.) — that Enter just
            // commits the candidate. Sending here would fire half-typed pinyin.
            if (e.nativeEvent.isComposing) return
            // Shift+Enter inserts a newline; plain Enter (or ⌘/Ctrl+Enter) sends.
            if (e.shiftKey) return
            e.preventDefault()
            send()
          }}
        />
        <div className="composer-bar">
          {/* 模型选择 */}
          <div className={'menu' + (openMenu === 'agent' ? ' open' : '')} id="agentMenu">
            <button className="cb-btn" data-menu="agentMenu" onClick={() => setOpenMenu(openMenu === 'agent' ? null : 'agent')}>
              <span className="mc-logo-sm" style={{ background: logo.bg, color: logo.color }}>{logo.glyph}</span>
              <span id="agentLabel">{agent?.displayName ?? ''}</span>
              {CHEV_DD}
            </button>
            <div className="menu-pop">
              <div className="menu-label">编码代理</div>
              {installedProviders.map(p => {
                const lg = logoFor(p.id)
                return (
                  <button
                    className={'menu-item' + (p.id === agentId ? ' on' : '')}
                    data-agent={p.displayName}
                    key={p.id}
                    onClick={() => chooseAgent(p)}
                  >
                    <span className="mc-logo-sm" style={{ background: lg.bg, color: lg.color }}>{lg.glyph}</span>
                    {p.displayName}
                    {CHECK}
                  </button>
                )
              })}
            </div>
          </div>
          {/* 模型版本选择 */}
          <div className={'menu' + (openMenu === 'ver' ? ' open' : '')} id="verMenu">
            <button className="cb-btn" data-menu="verMenu" onClick={() => { setCustomModelMode(false); setOpenMenu(openMenu === 'ver' ? null : 'ver') }}>
              <span id="verLabel">{model?.label ?? modelId}</span>
              {CHEV_DD}
            </button>
            <div className="menu-pop" id="verPop">
              <div className="menu-label">模型版本</div>
              {models.map(m => (
                <button
                  className={'menu-item' + (m.id === modelId ? ' on' : '')}
                  data-ver={m.id}
                  key={m.id}
                  onClick={() => chooseModel(m.id)}
                >
                  {m.label}
                  {m.description && <span className="sub">{m.description}</span>}
                  {CHECK}
                </button>
              ))}
              {customModelMode ? (
                <div className="menu-item" style={{ padding: '4px 8px' }}>
                  <input
                    autoFocus
                    placeholder="输入模型 id"
                    value={customModelInput}
                    style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--accent)', borderRadius: 6, padding: '4px 8px', color: 'var(--fg)', fontSize: 12.5, outline: 'none' }}
                    onChange={e => setCustomModelInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); confirmCustomModel() } else if (e.key === 'Escape') { setCustomModelMode(false) } }}
                  />
                </div>
              ) : (
                <button
                  className="menu-item"
                  data-ver="__custom__"
                  onClick={openCustomModel}
                >
                  自定义模型…
                </button>
              )}
            </div>
          </div>
          {/* 权限模式选择 — agent 能自主动多少(只读/自动/完全) */}
          <div className={'menu' + (openMenu === 'perm' ? ' open' : '')} id="permMenu">
            <button
              className={'cb-btn cb-perm perm-' + permissionMode}
              data-menu="permMenu"
              title={providerSupportsPermissions(agentId) ? '权限模式:agent 能自主执行到什么程度' : '当前编码代理不支持权限档,按其默认行为运行'}
              onClick={() => setOpenMenu(openMenu === 'perm' ? null : 'perm')}
            >
              {SHIELD}
              <span>{permissionModeLabel(permissionMode)}</span>
              {CHEV_DD}
            </button>
            <div className="menu-pop perm-pop">
              <div className="menu-label">权限模式{providerSupportsPermissions(agentId) ? '' : ' · 当前代理不支持'}</div>
              {PERMISSION_MODES.map(pm => (
                <button
                  className={'menu-item' + (pm.id === permissionMode ? ' on' : '')}
                  data-perm={pm.id}
                  key={pm.id}
                  onClick={() => { setPermissionMode(pm.id); setOpenMenu(null) }}
                >
                  <div className="pm-main">
                    <div className="pm-t">{pm.label}</div>
                    <div className="pm-d">{pm.desc}</div>
                  </div>
                  {CHECK}
                </button>
              ))}
            </div>
          </div>
          <button className="cb-btn" id="attachBtn" title="附加文件" onClick={pickFiles}>
            {PAPERCLIP}
          </button>
          <button className="cb-btn" title={expanded ? '收起输入框' : '放大输入框'} onClick={() => setExpanded(e => !e)}>
            {expanded ? COLLAPSE_ICON : EXPAND_ICON}
          </button>
          <div className="spacer" />
          {running && !text.trim() ? (
            <button className="send stop" id="stopBtn" title="停止 (Esc)" onClick={handleStop}>{STOP_ICON}</button>
          ) : (
            <button className={`send${busy ? ' queueing' : ''}`} id="sendBtn" title={busy ? '执行中 · 发送将进入队列' : '发送 (回车)'} disabled={disabled || readOnly} onClick={send}>{SEND_ARROW}</button>
          )}
        </div>
      </div>
    </div>
  )
}
