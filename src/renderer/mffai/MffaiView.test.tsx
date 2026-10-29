import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import MffaiView, { MFFAI_EXPECTED_RSS_MB } from './MffaiView'

let mffai: any
let eventCb: (e: any) => void

function setup(state: any) {
  eventCb = () => {}
  mffai = {
    state: vi.fn(async () => state),
    enable: vi.fn(async () => ({ ...state, enabled: true })),
    restart: vi.fn(async () => state),
    resetTrip: vi.fn(async () => state),
    setAutostart: vi.fn(async () => state),
    tail: vi.fn(async () => ({ events: [] })),
    prompt: vi.fn(async () => ({ accepted: true, turnId: 't1' })),
    onEvent: (cb: any) => { eventCb = cb; return () => {} },
    onAlert: () => () => {},
  }
  ;(window as any).forge = { mffai, setSettings: vi.fn(async () => ({})) }
}

describe('MffaiView', () => {
  beforeEach(() => vi.useRealTimers())

  it('disabled -> EnableCard with memory and data dir', async () => {
    setup({ enabled: false, autostart: true, running: false, dataDir: '/x/mff-ai' })
    render(<MffaiView />)
    expect(await screen.findByText(`约 ${MFFAI_EXPECTED_RSS_MB} MB`)).toBeInTheDocument()
    expect(screen.getByText('/x/mff-ai')).toBeInTheDocument()
    fireEvent.click(screen.getByText('启用'))
    await waitFor(() => expect(mffai.enable).toHaveBeenCalled())
  })

  it('running -> 运行中', async () => {
    setup({ enabled: true, autostart: true, running: true, rssMb: 99, supervisor: { state: 'running', version: '0.1.0' } })
    render(<MffaiView />)
    expect(await screen.findByText('运行中')).toBeInTheDocument()
    expect(screen.getByText('99 MB')).toBeInTheDocument()
  })

  it('tripped -> 重新启动 calls resetTrip', async () => {
    setup({ enabled: true, autostart: true, running: false, supervisor: { state: 'tripped', version: '0.1.0' } })
    render(<MffaiView />)
    expect(await screen.findByText('已熔断')).toBeInTheDocument()
    fireEvent.click(screen.getByText('重新启动'))
    expect(mffai.resetTrip).toHaveBeenCalled()
  })

  it('incompatible -> 重新启动 calls restart', async () => {
    setup({ enabled: true, autostart: true, running: true, compatible: false, supervisor: { state: 'running', version: '0.0.1' } })
    render(<MffaiView />)
    expect(await screen.findByText('版本不兼容')).toBeInTheDocument()
    fireEvent.click(screen.getByText('重新启动'))
    expect(mffai.restart).toHaveBeenCalled()
  })

  it('debug panel: 发送 calls prompt and assistant event renders', async () => {
    setup({ enabled: true, autostart: true, running: true, supervisor: { state: 'running', version: '0.1.0' } })
    const { container } = render(<MffaiView />)
    await screen.findByText('发送')
    fireEvent.change(container.querySelector('.mffai-send input')!, { target: { value: 'hi' } })
    fireEvent.click(screen.getByText('发送'))
    expect(mffai.prompt).toHaveBeenCalledWith('hi')
    act(() => eventCb({ seq: 5, ts: 1, type: 'message.assistant', payload: { turnId: 't1', text: 'echo: hi' } }))
    expect(await screen.findByText('echo: hi')).toBeInTheDocument()
  })
})
