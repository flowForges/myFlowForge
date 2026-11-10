import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import MffaiView from './MffaiView'
import { AddAccount } from './AddAccount'
import { route } from './route'

let mffai: any
/** 与 preload 同语义:每个订阅者都收到事件,退订真的移除 */
let listeners: Set<(e: any) => void>
const emit = (e: any) => { for (const cb of [...listeners]) cb(e) }
const model = (id: string) => ({ id, name: id.toUpperCase(), context: 1, output: 1, image: false, reasoning: 'none', toolCall: true })
const presets = [
  { id: 'p-key', label: 'Key套餐', billing: 'metered', restriction: 'none', auth: 'api-key', protocols: [], docsUrl: '' },
  { id: 'p-code', label: '编程套餐', billing: 'subscription', restriction: 'coding-tools-only', auth: 'api-key', protocols: [], docsUrl: '' },
  { id: 'p-gpt', label: 'ChatGPT', billing: 'subscription', restriction: 'none', auth: 'chatgpt-oauth', protocols: [], docsUrl: '' },
  { id: 'custom-openai', label: '自定义', billing: 'metered', restriction: 'none', auth: 'api-key', protocols: [], docsUrl: '' },
]
let accounts: any[]
let catalogDefault: any

function setup() {
  listeners = new Set()
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
    onEvent: (cb: any) => { listeners.add(cb); return () => { listeners.delete(cb) } },
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
  // 默认页成了对话(Task 6);这些测试写在调试面板是默认页的时候,挂载时先落在调试页
  route.set({ page: 'debug' })
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
    act(() => emit({ seq: 1, ts: 1, type: 'account.updated', payload: {} }))
    expect(await screen.findByText('acc3')).toBeInTheDocument()
    expect(screen.getByText('出错')).toBeInTheDocument()
  })

  it('remove reloads, setDefault passes first model', async () => {
    await openConnections()
    fireEvent.click(screen.getAllByText('设为默认')[0])
    await waitFor(() => expect(mffai.models.setDefault).toHaveBeenCalledWith('a1', 'm1'))
    await waitFor(() => expect(mffai.models.accounts.mock.calls.length).toBe(3))
    const before = mffai.models.accounts.mock.calls.length
    fireEvent.click(screen.getAllByText('删除')[0])
    fireEvent.click(document.querySelector('.mffai-confirm .confirm-danger')!)
    await waitFor(() => expect(mffai.models.removeAccount).toHaveBeenCalledWith('a1'))
    await waitFor(() => expect(mffai.models.accounts.mock.calls.length).toBe(before + 1))
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

  // 02 Task 13:默认模型下拉不再固定用第一个模型;选第二个就发第二个
  it('choosing the second model on an account sends that one, not the first', async () => {
    mffai.models.catalog = vi.fn(async () => ({
      presets, models: { 'p-key': [model('m1'), model('m9')], 'p-code': [model('m2')] }, default: catalogDefault,
    }))
    await openConnections()
    await screen.findByText('acc1')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'm9' } })
    fireEvent.click(screen.getAllByText('设为默认')[0])
    await waitFor(() => expect(mffai.models.setDefault).toHaveBeenCalledWith('a1', 'm9'))
  })

  // 默认账号的下拉初始就是目录记的默认模型,不是它清单里的第一个
  it('the default account initializes to the catalog default model, not array[0]', async () => {
    mffai.models.catalog = vi.fn(async () => ({
      presets, models: { 'p-key': [model('m1')], 'p-code': [model('m2'), model('m7')] }, default: { accountId: 'a2', modelId: 'm7' },
    }))
    await openConnections()
    await screen.findByText('acc2')
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('m7')
  })

  // 账号自己标的限制(自定义预设账号)比预设的优先:预设是 none,账号是 coding-tools-only 时徽章照样出来
  it('an account-level restriction override shows the badge even when the preset itself is unrestricted', async () => {
    accounts = [...accounts, { id: 'a9', presetId: 'custom-openai', label: 'cust', state: 'ok', restriction: 'coding-tools-only' }]
    await openConnections()
    const row = (await screen.findByText('cust')).closest('.mffai-row') as HTMLElement
    expect(within(row).getByText('限编程工具')).toBeInTheDocument()
  })

  // secretsBackend unavailable / unreadable:钥匙串不可用块(10.1,此前只处理了 plaintext-file)
  it('secretsBackend unavailable or unreadable shows the 钥匙串不可用 chip', async () => {
    mffai.models.accounts = vi.fn(async () => ({ accounts, secretsBackend: 'unavailable' }))
    await openConnections()
    expect(await screen.findByText('钥匙串不可用')).toBeInTheDocument()
  })

  // needs_login 账号是 ChatGPT 预设时才有重新登录;a2 是 api-key 预设,不出这个按钮
  it('重新登录 only appears for a needs_login ChatGPT-oauth account, and calls chatgpt.begin', async () => {
    accounts = [...accounts, { id: 'a4', presetId: 'p-gpt', label: 'gpt-broken', state: 'needs_login' }]
    await openConnections()
    await screen.findByText('gpt-broken')
    expect(screen.queryAllByText('重新登录')).toHaveLength(1)
    fireEvent.click(screen.getByText('重新登录'))
    await waitFor(() => expect(mffai.chatgpt.begin).toHaveBeenCalled())
  })
  // auth.chatgpt.begin 不带账号 id,重登的是第一个坏掉的账号:按钮只有一个,在账号列表上面,不在某一行里
  it('two needs_login ChatGPT accounts: one 重新登录, above the account list, not inside a row', async () => {
    accounts = [...accounts,
      { id: 'a4', presetId: 'p-gpt', label: 'gpt-broken', state: 'needs_login' },
      { id: 'a5', presetId: 'p-gpt', label: 'gpt-broken-2', state: 'needs_login' }]
    await openConnections()
    await screen.findByText('gpt-broken-2')
    const btns = screen.getAllByRole('button', { name: '重新登录' })
    expect(btns).toHaveLength(1)
    expect(btns[0].closest('.mffai-row')).toBeNull()
    const firstRow = screen.getByText('acc1').closest('.mffai-row')!
    expect(btns[0].compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(btns[0])
    await waitFor(() => expect(mffai.chatgpt.begin).toHaveBeenCalledTimes(1))
  })

  it('no needs_login ChatGPT account: no 重新登录', async () => {
    accounts = [...accounts, { id: 'a4', presetId: 'p-gpt', label: 'gpt-ok', state: 'ok' }]
    await openConnections()
    await screen.findByText('gpt-ok')
    expect(screen.queryByRole('button', { name: '重新登录' })).toBeNull()
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

  it('list presets: empty catalog list falls back to the account models (picker + 设为默认)', async () => {
    accounts.push({ id: 'a3', presetId: 'p-gpt', label: 'gpt', state: 'ok', models: [model('gpt-x')] })
    mffai.models.catalog = vi.fn(async () => ({ presets, models: { 'p-key': [model('m1')], 'p-code': [model('m2')], 'p-gpt': [] }, default: catalogDefault }))
    const { container } = render(<MffaiView />)
    await waitFor(() => {
      const opts = [...container.querySelectorAll('.mffai-picker option')].map(o => o.textContent)
      expect(opts).toContain('gpt / GPT-X')
    })
    fireEvent.click(await screen.findByText('连接'))
    await screen.findByText('gpt')
    const btn = screen.getAllByText('设为默认')[2] as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    await waitFor(() => expect(mffai.models.setDefault).toHaveBeenCalledWith('a3', 'gpt-x'))
  })

  it('shows reasoning folded and usage', async () => {
    render(<MffaiView />)
    await screen.findByText('发送')
    act(() => {
      emit({ seq: 1, ts: 1, type: 'message.reasoning.delta', payload: { turnId: 't', text: 'thinking' } })
      emit({ seq: 2, ts: 1, type: 'message.assistant', payload: { turnId: 't', text: 'ans' } })
      emit({ seq: 3, ts: 1, type: 'turn.usage', payload: { turnId: 't', input: 10, output: 5 } })
    })
    expect(await screen.findByText('推理')).toBeInTheDocument()
    expect(screen.getByText('10 / 5')).toBeInTheDocument()
    expect((screen.getByText('推理').closest('details') as HTMLDetailsElement).open).toBe(false)
  })
})

describe('AddAccount ChatGPT flow cleanup', () => {
  beforeEach(setup)
  const gptForm = async (ui = <AddAccount presets={presets as any} onDone={vi.fn()} />) => {
    const r = render(ui)
    fireEvent.click(screen.getByText('添加账号'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p-gpt' } })
    // begin 的 then 与随后订阅事件的 effect 都在 act 里落定;否则 findByText 看到「取消」时订阅可能还没挂上
    await act(async () => { fireEvent.click(screen.getByText('用 ChatGPT 登录')) })
    expect(screen.getByText('取消')).toBeInTheDocument()
    expect(listeners.size).toBe(1)
    return r
  }

  it('own flow ended ok closes the form and reloads; other accounts / flows do not', async () => {
    const onDone = vi.fn()
    await gptForm(<AddAccount presets={presets as any} onDone={onDone} />)
    act(() => emit({ seq: 1, ts: 1, type: 'account.updated', payload: { account: { id: 'other', presetId: 'p-key', label: 'x', state: 'error' } } }))
    act(() => emit({ seq: 2, ts: 1, type: 'auth.chatgpt.ended', payload: { flowId: 'f0', ok: true, accountId: 'zz' } }))
    expect(screen.getByText('取消')).toBeInTheDocument()
    expect(onDone).not.toHaveBeenCalled()
    act(() => emit({ seq: 3, ts: 1, type: 'auth.chatgpt.ended', payload: { flowId: 'f1', ok: true, accountId: 'a9' } }))
    expect(screen.getByText('添加账号')).toBeInTheDocument()
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(mffai.chatgpt.cancel).not.toHaveBeenCalled()
  })

  it('own flow ended not ok shows 失败 and offers login again', async () => {
    const onDone = vi.fn()
    await gptForm(<AddAccount presets={presets as any} onDone={onDone} />)
    act(() => emit({ seq: 1, ts: 1, type: 'auth.chatgpt.ended', payload: { flowId: 'f1', ok: false } }))
    expect(screen.getByText('失败')).toBeInTheDocument()
    expect(screen.getByText('用 ChatGPT 登录')).toBeInTheDocument()
    expect(onDone).not.toHaveBeenCalled()
    // 流已结束:关表单不再取消
    fireEvent.click(screen.getByText('用 ChatGPT 登录'))
    await screen.findByText('取消')
    expect(screen.queryByText('失败')).toBeNull()
    expect(mffai.chatgpt.cancel).not.toHaveBeenCalled()
  })

  it('preset change cancels a pending flow once', async () => {
    await gptForm()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p-key' } })
    expect(mffai.chatgpt.cancel).toHaveBeenCalledTimes(1)
    expect(mffai.chatgpt.cancel).toHaveBeenCalledWith('f1')
  })

  it('unmount cancels a pending flow once', async () => {
    const { unmount } = await gptForm()
    unmount()
    expect(mffai.chatgpt.cancel).toHaveBeenCalledTimes(1)
  })

  it('a flow that begins after unmount is cancelled, not leaked', async () => {
    let resolve!: (v: { flowId: string }) => void
    mffai.chatgpt.begin = vi.fn(() => new Promise(r => { resolve = r }))
    const { unmount } = render(<AddAccount presets={presets as any} onDone={vi.fn()} />)
    fireEvent.click(screen.getByText('添加账号'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p-gpt' } })
    fireEvent.click(screen.getByText('用 ChatGPT 登录'))
    unmount()
    expect(mffai.chatgpt.cancel).not.toHaveBeenCalled()
    await act(async () => { resolve({ flowId: 'late' }) })
    expect(mffai.chatgpt.cancel).toHaveBeenCalledTimes(1)
    expect(mffai.chatgpt.cancel).toHaveBeenCalledWith('late')
  })

  it('a flow that begins after the preset changed away is cancelled and not shown', async () => {
    let resolve!: (v: { flowId: string }) => void
    mffai.chatgpt.begin = vi.fn(() => new Promise(r => { resolve = r }))
    render(<AddAccount presets={presets as any} onDone={vi.fn()} />)
    fireEvent.click(screen.getByText('添加账号'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p-gpt' } })
    fireEvent.click(screen.getByText('用 ChatGPT 登录'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p-key' } })
    await act(async () => { resolve({ flowId: 'late' }) })
    expect(mffai.chatgpt.cancel).toHaveBeenCalledWith('late')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p-gpt' } })
    expect(screen.getByText('用 ChatGPT 登录')).toBeInTheDocument()
  })

  it('unmount without a flow does not cancel', () => {
    const { unmount } = render(<AddAccount presets={presets as any} onDone={vi.fn()} />)
    unmount()
    expect(mffai.chatgpt.cancel).not.toHaveBeenCalled()
  })

  it('empty preset list while open does not crash and 添加 is disabled', () => {
    const { rerender } = render(<AddAccount presets={presets as any} onDone={vi.fn()} />)
    fireEvent.click(screen.getByText('添加账号'))
    rerender(<AddAccount presets={[]} onDone={vi.fn()} />)
    expect((screen.getByText('添加') as HTMLButtonElement).disabled).toBe(true)
  })

  it('添加 is disabled while in flight (no double submit)', async () => {
    let resolve!: (v: unknown) => void
    mffai.models.addAccount = vi.fn(() => new Promise(r => { resolve = r }))
    const onDone = vi.fn()
    render(<AddAccount presets={presets as any} onDone={onDone} />)
    fireEvent.click(screen.getByText('添加账号'))
    fireEvent.click(screen.getByText('添加'))
    expect((screen.getByText('添加') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByText('添加'))
    expect(mffai.models.addAccount).toHaveBeenCalledTimes(1)
    await act(async () => { resolve({}) })
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('confirm dialog has an accessible name', () => {
    render(<AddAccount presets={presets as any} onDone={vi.fn()} />)
    fireEvent.click(screen.getByText('添加账号'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p-code' } })
    fireEvent.click(screen.getByText('添加'))
    expect(screen.getByRole('dialog', { name: '此套餐仅限编程工具内使用' })).toBeInTheDocument()
  })
})

describe('AddAccount custom preset fields', () => {
  beforeEach(setup)

  it('模型 id and 仅限编程工具 only show for the custom preset', async () => {
    render(<AddAccount presets={presets as any} onDone={vi.fn()} />)
    fireEvent.click(screen.getByText('添加账号'))
    expect(screen.queryByLabelText('模型 id')).toBeNull()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'custom-openai' } })
    expect(screen.getByLabelText('模型 id')).toBeInTheDocument()
    expect(screen.getByLabelText('仅限编程工具')).toBeInTheDocument()
  })

  it('模型 id is comma-split, trimmed and deduped; restriction sent only when checked, only for custom', async () => {
    const onDone = vi.fn()
    render(<AddAccount presets={presets as any} onDone={onDone} />)
    fireEvent.click(screen.getByText('添加账号'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'custom-openai' } })
    fireEvent.change(document.querySelector('input[type=password]') as HTMLInputElement, { target: { value: 'sk-c' } })
    fireEvent.change(screen.getByLabelText('模型 id'), { target: { value: ' m-a , m-b ,m-a, ,m-b ' } })
    fireEvent.click(screen.getByLabelText('仅限编程工具'))
    fireEvent.click(screen.getByText('添加'))
    await waitFor(() => expect(mffai.models.addAccount).toHaveBeenCalledWith({
      presetId: 'custom-openai', apiKey: 'sk-c', modelIds: ['m-a', 'm-b'], restriction: 'coding-tools-only',
    }))
  })

  it('a non-custom preset never sends modelIds or restriction', async () => {
    render(<AddAccount presets={presets as any} onDone={vi.fn()} />)
    fireEvent.click(screen.getByText('添加账号'))
    fireEvent.change(document.querySelector('input[type=password]') as HTMLInputElement, { target: { value: 'sk-d' } })
    fireEvent.click(screen.getByText('添加'))
    await waitFor(() => expect(mffai.models.addAccount).toHaveBeenCalledWith({ presetId: 'p-key', apiKey: 'sk-d' }))
  })
})

// Review Focus 8:API key 和 Telegram 令牌、插件敏感设置同一条规矩 —— 提交之后不留在 DOM、日志、存储里
describe('AddAccount API key never lingers after a successful add', () => {
  beforeEach(setup)
  afterEach(() => { vi.unstubAllGlobals() })

  it('key is gone from the DOM, console and storage once the add resolves', async () => {
    const spies = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})]
    // jsdom 环境本来没挂 localStorage/sessionStorage;临时装一份内存实现,只为了能断言「没写进去」
    const memStorage = (): Storage => {
      const d: Record<string, string> = {}
      return {
        getItem: (k) => d[k] ?? null, setItem: (k, v) => { d[k] = v }, removeItem: (k) => { delete d[k] },
        clear: () => { for (const k of Object.keys(d)) delete d[k] }, key: (i) => Object.keys(d)[i] ?? null,
        get length() { return Object.keys(d).length },
      }
    }
    vi.stubGlobal('localStorage', memStorage())
    vi.stubGlobal('sessionStorage', memStorage())
    const secret = 'sk-super-secret-42'
    render(<AddAccount presets={presets as any} onDone={vi.fn()} />)
    fireEvent.click(screen.getByText('添加账号'))
    fireEvent.change(document.querySelector('input[type=password]') as HTMLInputElement, { target: { value: secret } })
    fireEvent.click(screen.getByText('添加'))
    await waitFor(() => expect(mffai.models.addAccount).toHaveBeenCalled())
    await screen.findByText('添加账号')
    expect(document.body.innerHTML).not.toContain(secret)
    for (const spy of spies) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(secret)
    const dump = (s: Storage) => Object.keys(s).map((k) => s.getItem(k)).join('')
    expect(dump(localStorage)).not.toContain(secret)
    expect(dump(sessionStorage)).not.toContain(secret)
  })
})

describe('subscriptions and reasoning', () => {
  beforeEach(setup)

  it('unmount unsubscribes from events', async () => {
    const off = vi.fn()
    mffai.onEvent = () => off
    const { unmount } = render(<MffaiView />)
    await screen.findByText('发送')
    unmount()
    expect(off).toHaveBeenCalled()
  })

  it('reasoning shows before the first assistant delta', async () => {
    render(<MffaiView />)
    await screen.findByText('发送')
    act(() => emit({ seq: 1, ts: 1, type: 'message.reasoning.delta', payload: { turnId: 't', text: 'pondering' } }))
    expect(await screen.findByText('推理')).toBeInTheDocument()
    act(() => emit({ seq: 2, ts: 1, type: 'message.assistant.delta', payload: { turnId: 't', text: 'hey' } }))
    expect(await screen.findByText(/hey/)).toBeInTheDocument()
    expect(screen.getAllByText('推理')).toHaveLength(1)
  })
})
