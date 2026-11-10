import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { MffaiState } from '@mffai/protocol'
import { FaultPanel } from './FaultPanel'
import { RUNNING_STATE } from '../test/fakeForge'

const tripped = (p: Partial<MffaiState> = {}): MffaiState => ({
  ...RUNNING_STATE, running: false, supervisor: { ...RUNNING_STATE.supervisor!, state: 'tripped', trippedReason: 'crash-loop', version: '0.8.2' }, ...p,
})
const panel = (state: MffaiState, busy = false) => {
  const onRestart = vi.fn(), onResetTrip = vi.fn()
  render(<FaultPanel state={state} busy={busy} onRestart={onRestart} onResetTrip={onResetTrip} />)
  return { onRestart, onResetTrip }
}

describe('FaultPanel', () => {
  it('tripped: title, state chip, the reason code and the version; 重新启动 is resetTrip', () => {
    const h = panel(tripped())
    expect(screen.getByText('后台已熔断')).toBeInTheDocument()
    expect(screen.getByText('已熔断')).toBeInTheDocument()
    expect(screen.getByText('crash-loop').tagName).toBe('CODE')
    expect(screen.getByText('0.8.2')).toBeInTheDocument()
    expect(document.querySelector('.mffai-fault .mffai-i')).not.toBeNull()
    fireEvent.click(screen.getByText('重新启动'))
    expect(h.onResetTrip).toHaveBeenCalledTimes(1)
    expect(h.onRestart).not.toHaveBeenCalled()
    expect(screen.queryByText('调试')).toBeNull()
  })

  it('incompatible: 版本不兼容 and 重新启动 is restart even when tripped', () => {
    const h = panel(tripped({ compatible: false }))
    expect(screen.getByText('版本不兼容', { selector: 'h2' })).toBeInTheDocument()
    fireEvent.click(screen.getByText('重新启动'))
    expect(h.onRestart).toHaveBeenCalledTimes(1)
    expect(h.onResetTrip).not.toHaveBeenCalled()
  })

  it('supervisor gone: 已停止 and restart, no code chip', () => {
    const h = panel(tripped({ supervisor: undefined }))
    expect(screen.getByText('已停止', { selector: 'h2' })).toBeInTheDocument()
    expect(document.querySelector('code')).toBeNull()
    fireEvent.click(screen.getByText('重新启动'))
    expect(h.onRestart).toHaveBeenCalledTimes(1)
    expect(h.onResetTrip).not.toHaveBeenCalled()
  })

  it('busy hides the button', () => {
    panel(tripped({ op: 'resetTrip' }), true)
    expect(screen.queryByText('重新启动')).toBeNull()
    expect(screen.getByText('后台已熔断')).toBeInTheDocument()
  })

  it('starting and restarting: no 重新启动, the title is the state label', () => {
    for (const [state, text] of [['starting', '启动中'], ['restarting', '重启中']] as const) {
      const { unmount } = render(<FaultPanel state={tripped({ supervisor: { ...RUNNING_STATE.supervisor!, state } })} busy={false} onRestart={() => {}} onResetTrip={() => {}} />)
      expect(screen.getByText(text, { selector: 'h2' })).toBeInTheDocument()
      expect(screen.queryByText('重新启动')).toBeNull()
      unmount()
    }
  })
})
