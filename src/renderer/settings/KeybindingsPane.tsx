import { useEffect, useMemo, useState } from 'react'
import type { Keybindings } from '@shared/types'
import {
  KEYBINDING_ACTIONS, effectiveBindings, findDuplicates, formatAccelerator,
  eventToAccelerator, hasModifier, type ActionDef,
} from '@shared/keybindings'
import { rendererPlatform } from '../state/useKeybindings'

interface KeybindingsPaneProps {
  keybindings: Keybindings
  onChange: (kb: Keybindings) => void
  globalFailed: string[]
}

// Preserve registry order within each group.
function groupActions(): { group: string; actions: ActionDef[] }[] {
  const order: string[] = []
  const byGroup = new Map<string, ActionDef[]>()
  for (const a of KEYBINDING_ACTIONS) {
    if (!byGroup.has(a.group)) { byGroup.set(a.group, []); order.push(a.group) }
    byGroup.get(a.group)!.push(a)
  }
  return order.map(g => ({ group: g, actions: byGroup.get(g)! }))
}

export function KeybindingsPane({ keybindings, onChange, globalFailed }: KeybindingsPaneProps) {
  const platform = rendererPlatform()
  const overrides = keybindings.overrides ?? {}
  const [recording, setRecording] = useState<string | null>(null)

  const eff = useMemo(() => effectiveBindings(overrides), [overrides])
  const dups = useMemo(() => findDuplicates(eff), [eff])
  // action id → true when its accelerator collides with another action's.
  const conflictIds = useMemo(() => {
    const s = new Set<string>()
    for (const ids of dups.values()) ids.forEach(id => s.add(id))
    return s
  }, [dups])
  const groups = useMemo(groupActions, [])

  const setOverride = (id: string, accel: string) => onChange({ overrides: { ...overrides, [id]: accel } })
  const resetOne = (id: string) => {
    const next = { ...overrides }
    delete next[id]
    onChange({ overrides: next })
  }
  const resetAll = () => onChange({ overrides: {} })

  // While recording a row, capture the next key combo. Esc cancels; Backspace/Delete unbinds.
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') { setRecording(null); return }
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setOverride(recording, '') // explicit unbind
        setRecording(null)
        return
      }
      const accel = eventToAccelerator(e, platform)
      if (!accel) return // bare modifier — keep waiting
      setOverride(recording, accel)
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, platform, overrides])

  return (
    <div className="kb-pane">
      <div className="set-group-head">
        <p className="set-hint">点按键位进行录制,按下新的组合键即可修改。<b>Esc</b> 取消,<b>Backspace</b> 解绑。系统级快捷键在应用后台也能触发。</p>
        <button className="kb-reset-all" onClick={resetAll}>全部恢复默认</button>
      </div>

      {groups.map(({ group, actions }) => (
        <div className="set-group" key={group}>
          <h4>{group}{actions[0].scope === 'global' && <span className="kb-scope">系统级</span>}</h4>
          {actions.map(a => {
            const accel = eff[a.id]
            const isRec = recording === a.id
            const conflict = conflictIds.has(a.id)
            const osTaken = a.scope === 'global' && globalFailed.includes(a.id)
            const noMod = !!accel && !hasModifier(accel)
            const overridden = Object.prototype.hasOwnProperty.call(overrides, a.id)
            return (
              <div className="set-row kb-row" key={a.id}>
                <div className="info">
                  <div className="t">{a.label}</div>
                  <div className="d">{a.desc}</div>
                  {conflict && <div className="kb-warn err">⚠ 与其他动作快捷键冲突</div>}
                  {osTaken && <div className="kb-warn err">⚠ 已被系统或其他软件占用</div>}
                  {noMod && !conflict && <div className="kb-warn">建议加一个修饰键,当前可能与文本输入冲突</div>}
                </div>
                <div className="kb-controls">
                  <button
                    className={`kb-key${isRec ? ' rec' : ''}${conflict || osTaken ? ' bad' : ''}`}
                    onClick={() => setRecording(isRec ? null : a.id)}
                  >
                    {isRec ? '按下组合键…' : (accel ? formatAccelerator(accel, platform) : '未绑定')}
                  </button>
                  {overridden && (
                    <button className="kb-mini" title="恢复默认" onClick={() => resetOne(a.id)}>重置</button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
