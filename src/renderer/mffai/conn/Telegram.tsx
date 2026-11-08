// 连接 · Telegram(08 §10.3)。状态行、dropped 小表、令牌、启用和过期分钟、配对、已配对、项目、聊天。
// 令牌只在一个不受控的密码框里:不进 React state、不进日志(出错只记方法和错误码)、不进存储,
// 保存成功就清空。配置每次保存都带整份(config.get 的原样对象)。channel.* 事件到了重取状态和聊天。
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { SandboxStatus, TelegramChats, TelegramStatus } from '@mffai/protocol'
import { fmtRelTime } from '@shared/relTime'
import { call, isUnsupported, retryable, toCallError } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { route } from '../route'
import { label } from '../labels'
import { Chip, type ChipTone } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { Confirm } from '../ui/Confirm'
import { Pairing } from './Pairing'
import { Projects, SaveFailureChip, useConfigSet, type FullConfig } from './Projects'

const ERR_INVALID = -32602

const STATE_TONE: Record<TelegramStatus['state'], ChipTone> = {
  online: 'ok', starting: 'warn', reconnecting: 'warn', disabled: 'muted', no_token: 'muted',
  unauthorized: 'bad', conflict: 'bad', secrets_unavailable: 'bad',
}
const SECRETS: Record<TelegramStatus['secretsBackend'], [string, ChipTone]> = {
  keychain: ['钥匙串', 'ok'], dpapi: ['钥匙串', 'ok'], 'secret-service': ['钥匙串', 'ok'],
  'plaintext-file': ['明文存储', 'warn'], unavailable: ['钥匙串不可用', 'bad'], unreadable: ['钥匙串不可用', 'bad'],
}
const PROXY: Record<TelegramStatus['proxy'], string> = { none: '直连', env: '环境代理', socks: 'SOCKS 代理' }
const DROPPED: [keyof TelegramStatus['dropped'], string][] = [
  ['unpaired', '陌生人'], ['stale', '过期'], ['group', '群'], ['attachment', '附件'], ['badUpdate', '坏消息'],
]

type Failure = { code: string } | 'failed'
const failureOf = (method: string, e: unknown): Failure => {
  const c = toCallError(e)
  console.error(`mffai ${method}`, c.code)
  return c.code === ERR_INVALID && c.message ? { code: c.message } : 'failed'
}
const FailChip = ({ failure }: { failure: Failure | null }) =>
  !failure ? null : failure === 'failed' ? <span className="mffai-fail">失败</span> : <CodeChip code={failure.code} />

/** 一个按钮的动作:ref 守卫(同一帧两次点击只发一次)、忙、失败 */
function useAction() {
  const inflight = useRef(false)
  const alive = useRef(true)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const run = async (method: string, f: () => Promise<unknown>): Promise<boolean> => {
    if (inflight.current) return false
    inflight.current = true
    setBusy(true)
    setFailure(null)
    try {
      await f()
      return true
    } catch (e) {
      const fl = failureOf(method, e)
      if (alive.current) setFailure(fl)
      return false
    } finally {
      inflight.current = false
      if (alive.current) setBusy(false)
    }
  }
  return { run, busy, failure, alive }
}

function StatusRow({ s, onChanged }: { s: TelegramStatus; onChanged: () => void }) {
  const retry = useRef(retryable()).current
  const { run, busy, failure } = useAction()
  const [secrets, secretsTone] = SECRETS[s.secretsBackend] ?? [s.secretsBackend, 'muted']
  const clearWebhook = () => void run('channel.telegram.clearWebhook', async () => {
    await call('channel.telegram.clearWebhook', { commandId: retry.id('clearWebhook') })
    retry.done('clearWebhook')
    onChanged()
  })
  return (
    <>
      <div className="mffai-row" data-testid="mffai-tg-status">
        <Chip tone={STATE_TONE[s.state] ?? 'muted'}>{label('channelState', s.state)}</Chip>
        {s.reason && <CodeChip code={s.reason} />}
        {s.bot && <span>{`@${s.bot.username}`}</span>}
        <Chip tone={secretsTone}>{secrets}</Chip>
        <Chip>{PROXY[s.proxy] ?? s.proxy}</Chip>
        {s.lastOkAt !== undefined && <span className="mffai-k">{`最后在线 ${fmtRelTime(s.lastOkAt, Date.now())}`}</span>}
        {s.undelivered > 0 && <Chip tone="warn">{`未送达 ${s.undelivered}`}</Chip>}
        {s.problems.map((p) => <CodeChip key={p} code={p} />)}
        {s.state === 'conflict' && <button className="set-btn" disabled={busy} onClick={clearWebhook}>清除 webhook</button>}
        <FailChip failure={failure} />
      </div>
      <table className="mffai-tg-dropped">
        <thead><tr>{DROPPED.map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
        <tbody><tr>{DROPPED.map(([k]) => <td key={k}>{s.dropped[k]}</td>)}</tr></tbody>
      </table>
    </>
  )
}

function Token({ s, onChanged }: { s: TelegramStatus; onChanged: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [hasText, setHasText] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const { run, busy, failure, alive } = useAction()

  const save = () => void run('channel.telegram.setToken', async () => {
    const token = input.current?.value ?? ''
    if (!token) return
    const r = await call('channel.telegram.setToken', { token })
    if (input.current) input.current.value = ''
    if (!alive.current) return
    setHasText(false)
    setSaved(r.bot.username)
    onChanged()
  })
  const clear = () => void run('channel.telegram.clearToken', async () => {
    await call('channel.telegram.clearToken', {})
    if (!alive.current) return
    setConfirming(false)
    setSaved(null)
    onChanged()
  })

  return (
    <div className="mffai-row">
      <input ref={input} type="password" aria-label="令牌" autoComplete="off" spellCheck={false}
        onChange={(e) => { setHasText(e.target.value.length > 0); setSaved(null) }} />
      <button className="set-btn" disabled={!hasText || busy} onClick={save}>保存令牌</button>
      {saved && <Chip tone="ok">{`@${saved}`}</Chip>}
      {s.tokenSet && <button className="set-btn" disabled={busy} onClick={() => setConfirming(true)}>清除令牌</button>}
      {!confirming && <FailChip failure={failure} />}
      {confirming && (
        <Confirm title="清除令牌" rows={[['机器人', s.bot ? `@${s.bot.username}` : '-']]} confirmLabel="清除令牌" danger busy={busy}
          onCancel={() => setConfirming(false)} onConfirm={clear}>
          <FailChip failure={failure} />
        </Confirm>
      )}
    </div>
  )
}

function Settings({ config, onSaved }: { config: FullConfig; onSaved: () => void }) {
  const [minutes, setMinutes] = useState(String(config.staleMinutes))
  useEffect(() => { setMinutes(String(config.staleMinutes)) }, [config.staleMinutes])
  const { save, busy, failure } = useConfigSet()
  const n = Number(minutes)
  const minutesOk = minutes.trim() !== '' && Number.isFinite(n) && n !== config.staleMinutes
  const send = async (patch: Partial<FullConfig>) => { if (await save({ ...config, ...patch })) onSaved() }
  return (
    <div className="mffai-row">
      <label className="mffai-switch">
        <input type="checkbox" role="switch" checked={config.enabled} disabled={busy} onChange={(e) => void send({ enabled: e.target.checked })} />
        启用
      </label>
      <input type="number" aria-label="过期分钟" min={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
      <button className="set-btn" disabled={!minutesOk || busy} onClick={() => void send({ staleMinutes: n })}>保存分钟</button>
      <SaveFailureChip failure={failure} />
    </div>
  )
}

function Paired({ s, onChanged }: { s: TelegramStatus; onChanged: () => void }) {
  const retry = useRef(retryable()).current
  const [target, setTarget] = useState<{ accountId: string; name: string } | null>(null)
  const { run, busy, failure, alive } = useAction()
  const unpair = () => {
    if (!target) return
    const { accountId } = target
    void run('channel.telegram.unpair', async () => {
      await call('channel.telegram.unpair', { commandId: retry.id(accountId), accountId })
      retry.done(accountId)
      if (alive.current) setTarget(null)
      onChanged()
    })
  }
  return (
    <>
      {s.paired.map((p) => (
        <div key={p.accountId} className="mffai-row">
          <span>{p.name}</span>
          <span className="mffai-k">{fmtRelTime(p.pairedAt, Date.now())}</span>
          <button className="set-btn" onClick={() => setTarget({ accountId: p.accountId, name: p.name })}>撤销</button>
        </div>
      ))}
      {target && (
        <Confirm title="撤销配对" rows={[['账号', target.name]]} confirmLabel="撤销" danger busy={busy}
          onCancel={() => setTarget(null)} onConfirm={unpair}>
          <FailChip failure={failure} />
        </Confirm>
      )}
    </>
  )
}

function Chats({ chats }: { chats: TelegramChats['chats'] }) {
  return (
    <>
      {chats.map((c) => (
        <div key={c.chatId} className="mffai-row" data-testid="mffai-tg-chat">
          <button className="set-btn" onClick={() => route.set({ page: 'chat', sessionId: c.sessionId })}>{c.sessionId}</button>
          {c.project && <span>{c.project}</span>}
          {c.model && <span className="mffai-model">{c.model.modelId}</span>}
          {c.queued > 0 && <Chip>{`排队 ${c.queued}`}</Chip>}
          {c.running && <Chip tone="warn">运行中</Chip>}
        </div>
      ))}
    </>
  )
}

const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="mffai-group">
    <div className="mffai-grouphead"><span>{title}</span></div>
    {children}
  </div>
)

export function Telegram() {
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [statusFail, setStatusFail] = useState<'unsupported' | 'failed' | null>(null)
  const [config, setConfig] = useState<FullConfig | null>(null)
  const [chats, setChats] = useState<TelegramChats['chats']>([])
  const [level, setLevel] = useState<SandboxStatus['level'] | undefined>()
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const loadStatus = useCallback(() => {
    void call('channel.telegram.status', {}).then(
      (r) => { if (alive.current) { setStatus(r); setStatusFail(null) } },
      (e) => {
        if (!alive.current) return
        const c = toCallError(e)
        console.error('mffai channel.telegram.status', c.code)
        setStatusFail(isUnsupported(c) ? 'unsupported' : 'failed')
      },
    )
  }, [])
  const loadConfig = useCallback(() => {
    void call('channel.telegram.config.get', {}).then(
      (r) => { if (alive.current) setConfig(r as FullConfig) },
      (e) => console.error('mffai channel.telegram.config.get', toCallError(e).code),
    )
  }, [])
  const loadChats = useCallback(() => {
    void call('channel.telegram.chats', {}).then(
      (r) => { if (alive.current) setChats(r.chats) },
      (e) => console.error('mffai channel.telegram.chats', toCallError(e).code),
    )
  }, [])
  const loadLevel = useCallback(() => {
    void call('permissions.get', {}).then(
      (r) => { if (alive.current) setLevel(r.sandbox.level) },
      (e) => { if (alive.current) setLevel(undefined); console.error('mffai permissions.get', toCallError(e).code) },
    )
  }, [])
  const loadAll = useCallback(() => { loadStatus(); loadConfig(); loadChats(); loadLevel() }, [loadStatus, loadConfig, loadChats, loadLevel])
  useEffect(loadAll, [loadAll])

  useMffaiEvent({ types: ['channel.status', 'channel.paired', 'channel.unpaired', 'channel.pairing.burned', 'channel.worktree.merged'] }, () => {
    loadStatus()
    loadChats()
  })
  useMffaiEvent({ types: ['permissions.updated'] }, loadLevel)
  useMffaiReset(loadAll)

  const configSaved = () => { loadConfig(); loadStatus() }

  if (statusFail === 'unsupported') return <div className="mffai-conn mffai-tg"><Chip tone="bad">不支持</Chip></div>
  return (
    <div className="mffai-conn mffai-tg">
      {statusFail === 'failed' && <span className="mffai-fail">失败</span>}
      {status && (
        <>
          <StatusRow s={status} onChanged={loadStatus} />
          <Group title="令牌"><Token s={status} onChanged={loadStatus} /></Group>
        </>
      )}
      {config && <Settings config={config} onSaved={configSaved} />}
      {status && (
        <>
          <Group title="配对"><Pairing active={status.pairing.active} onChanged={loadStatus} /></Group>
          {status.paired.length > 0 && <Group title="已配对"><Paired s={status} onChanged={loadStatus} /></Group>}
        </>
      )}
      {config && <Group title="项目"><Projects config={config} level={level} onSaved={configSaved} /></Group>}
      {chats.length > 0 && <Group title="聊天"><Chats chats={chats} /></Group>}
    </div>
  )
}
