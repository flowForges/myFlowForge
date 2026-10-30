import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import MffaiView from './MffaiView'

let mffai: any
let eventCb: (e: any) => void
const model = (id: string) => ({ id, name: id.toUpperCase(), context: 1, output: 1, image: false, reasoning: 'none', toolCall: true })
const presets = [
  { id: 'p-key', label: 'Key套餐', billing: 'metered', restriction: 'none', auth: 'api-key', protocols: [], docsUrl: '' },
  { id: 'p-code', label: '编程套餐', billing: 'subscription', restriction: 'coding-tools-only', auth: 'api-key', protocols: [], docsUrl: '' },
  { id: 'p-gpt', label: 'ChatGPT', billing: 'subscription', restriction: 'none', auth: 'chatgpt-oauth', protocols: [], docsUrl: '' },
]
let accounts: any[]
let catalogDefault: any

function setup() {
  eventCb = () => {}
  accounts = [
    { id: 'a1', presetId: 'p-key', label: 'acc1', state: 'ok' },
    { id: 'a2', presetId: 'p-code', label: 'acc2', state: 'needs_login' },
  ]
  catalogDefault = { accountId: 'a2', modelId: 'm2' }
  mffai = {
    state: vi.fn(async () => ({ enabled: true, autostart: true, running: true, supervisor: { state: 'running', version: '0.1.0' } })),
    restart: vi.fn(), resetTrip: vi.fn(),
    tail: vi.fn(async () => ({ events: [] })),
    prompt: vi.fn(async () => ({ accepted: true, turnId: 't1' })),
    onEvent: (cb: any) => { eventCb = cb; return () => {} },
    onAlert: () => () => {},
    openExternal: vi.fn(async () => {}),
    chatgpt: { begin: vi.fn(async () => ({ flowId: 'f1' })), cancel: vi.fn(async () => ({ ok: true })) },
    models: {
      catalog: vi.fn(async () => ({ presets, models: { 'p-key': [model('m1')], 'p-code': [model('m2')] }, default: catalogDefault })),
      accounts: vi.fn(async () => ({ accounts, secretsBackend: 'plaintext-file' })),
      addAccount: vi.fn(async () => accounts[0]),
      removeAccount: vi.fn(async () => ({ ok: true })),
      testAccount: vi.fn(async () => ({ ok: true })),
      setDefault: vi.fn(async () => ({ ok: true })),
      quota: vi.fn(async (id: string) => id === 'a1' ? { windows: [{ label: '5h', usedPercent: 42 }] } : { link: 'https://x/usage' }),
    },
  }
  ;(window as any).forge = { mffai, setSettings: vi.fn() }
}

async function openConnections() {
  render(<MffaiView />)
  fireEvent.click(await screen.findByText('连接'))
  await screen.findByText('acc1')
}

describe('Connections', () => {
  beforeEach(setup)

  it('lists state labels, badges, quota', async () => {
    await openConnections()
    expect(screen.getByText('可用')).toBeInTheDocument()
    expect(screen.getByText('需要重新登录')).toBeInTheDocument()
    expect(screen.getByText('限编程工具')).toBeInTheDocument()
    expect(screen.getByText('明文存储')).toBeInTheDocument()
    expect(await screen.findByText('5h 42%')).toBeInTheDocument()
    fireEvent.click(await screen.findByText('用量'))
    expect(mffai.openExternal).toHaveBeenCalledWith('https://x/usage')
  })

  it('account.updated reloads the list', async () => {
    await openConnections()
    accounts = [...accounts, { id: 'a3', presetId: 'p-key', label: 'acc3', state: 'error' }]
    act(() => eventCb({ seq: 1, ts: 1, type: 'account.updated', payload: {} }))
    expect(await screen.findByText('acc3')).toBeInTheDocument()
    expect(screen.getByText('出错')).toBeInTheDocument()
  })

  it('remove reloads, setDefault passes first model', async () => {
    await openConnections()
    fireEvent.click(screen.getAllByText('设为默认')[0])
    await waitFor(() => expect(mffai.models.setDefault).toHaveBeenCalledWith('a1', 'm1'))
    fireEvent.click(screen.getAllByText('删除')[0])
    await waitFor(() => expect(mffai.models.removeAccount).toHaveBeenCalledWith('a1'))
    await waitFor(() => expect(mffai.models.accounts.mock.calls.length).toBeGreaterThan(2))
  })

  it('coding-tools-only preset: ack only after 继续', async () => {
    await openConnections()
    fireEvent.click(screen.getByText('添加账号'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p-code' } })
    const key = document.querySelector('input[type=password]') as HTMLInputElement
    fireEvent.change(key, { target: { value: 'sk-1' } })
    fireEvent.click(screen.getByText('添加'))
    expect(screen.getByText('此套餐仅限编程工具内使用')).toBeInTheDocument()
    expect(mffai.models.addAccount).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('继续'))
    await waitFor(() => expect(mffai.models.addAccount).toHaveBeenCalledWith({ presetId: 'p-code', apiKey: 'sk-1', restrictionAck: true }))
  })

  it('plain preset adds without ack; failure shows 失败 and key is cleared', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await openConnections()
    mffai.models.addAccount = vi.fn(async () => { throw new Error('x') })
    fireEvent.click(screen.getByText('添加账号'))
    const key = document.querySelector('input[type=password]') as HTMLInputElement
    fireEvent.change(key, { target: { value: 'sk-2' } })
    fireEvent.click(screen.getByText('添加'))
    expect(mffai.models.addAccount).toHaveBeenCalledWith({ presetId: 'p-key', apiKey: 'sk-2' })
    expect(await screen.findByText('失败')).toBeInTheDocument()
    expect((document.querySelector('input[type=password]') as HTMLInputElement).value).toBe('')
  })

  it('ChatGPT login begins a flow and can be cancelled', async () => {
    await openConnections()
    fireEvent.click(screen.getByText('添加账号'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p-gpt' } })
    fireEvent.click(screen.getByText('用 ChatGPT 登录'))
    await waitFor(() => expect(mffai.chatgpt.begin).toHaveBeenCalled())
    fireEvent.click(await screen.findByText('取消'))
    expect(mffai.chatgpt.cancel).toHaveBeenCalledWith('f1')
  })
})

describe('ModelPicker in debug panel', () => {
  beforeEach(setup)

  it('defaults to catalog default and passes the selection to prompt', async () => {
    const { container } = render(<MffaiView />)
    const sel = (await waitFor(() => {
      const el = container.querySelector('.mffai-picker') as HTMLSelectElement
      expect(el).toBeTruthy()
      return el
    }))
    await waitFor(() => expect(sel.selectedOptions[0].textContent).toBe('acc2 / M2'))
    fireEvent.change(container.querySelector('.mffai-send input')!, { target: { value: 'hi' } })
    fireEvent.click(screen.getByText('发送'))
    expect(mffai.prompt).toHaveBeenCalledWith('hi', { accountId: 'a2', modelId: 'm2' })
  })

  it('shows reasoning folded and usage', async () => {
    render(<MffaiView />)
    await screen.findByText('发送')
    act(() => {
      eventCb({ seq: 1, ts: 1, type: 'message.reasoning.delta', payload: { turnId: 't', text: 'thinking' } })
      eventCb({ seq: 2, ts: 1, type: 'message.assistant', payload: { turnId: 't', text: 'ans' } })
      eventCb({ seq: 3, ts: 1, type: 'turn.usage', payload: { turnId: 't', input: 10, output: 5 } })
    })
    expect(await screen.findByText('推理')).toBeInTheDocument()
    expect(screen.getByText('10 / 5')).toBeInTheDocument()
    expect((screen.getByText('推理').closest('details') as HTMLDetailsElement).open).toBe(false)
  })
})
