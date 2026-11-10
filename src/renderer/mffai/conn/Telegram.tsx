// 连接 · Telegram(08 §10.3)。状态行、dropped 小表、令牌、启用和过期分钟、配对、已配对、项目、聊天。
// 令牌只在一个不受控的密码框里:不进 React state、不进日志(出错只记方法和错误码)、不进存储,
// 保存成功就清空。配置每次保存都带整份(config.get 的原样对象)。channel.* 事件到了重取状态和聊天。
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { SandboxStatus, TelegramChats, TelegramStatus } from '@mffai/protocol'
import { fmtRelTime } from '@shared/relTime'
import { call, isUnsupported, retryable, toCallError } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { route } from '../route'
import { Icon } from '../shell/icons'
import { label } from '../labels'
import { Chip, type ChipTone } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { Confirm } from '../ui/Confirm'
import { Pairing } from './Pairing'
import { Projects, SaveFailureChip, useConfigSaver, type ConfigSaver, type FullConfig, type SaveFailure } from './Projects'

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

type Failure = { code: string } | 'unsupported' | 'failed'
const failureOf = (method: string, e: unknown): Failure => {
  const c = toCallError(e)
  console.error(`mffai ${method}`, c.code)
  return isUnsupported(c) ? 'unsupported' : c.code === ERR_INVALID && c.message ? { code: c.message } : 'failed'
}
const FailChip = ({ failure }: { failure: Failure | null }) => <SaveFailureChip failure={failure} />

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

function StatusRow({ s, onChanged, enable }: { s: TelegramStatus; onChanged: () => void; enable?: ReactNode }) {
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
      <div className="mffai-tg-head">
        <span className="mffai-tg-logo"><Icon name="send" size={18} /></span>
        <div className="mffai-tg-id" data-testid="mffai-tg-status">
          <div className="mffai-tg-name">
            {s.bot && <span className="mffai-tg-bot">{`@${s.bot.username}`}</span>}
            <Chip tone={STATE_TONE[s.state] ?? 'muted'} dot>{label('channelState', s.state)}</Chip>
            {s.reason && <CodeChip code={s.reason} />}
          </div>
          <div className="mffai-tg-meta">
            <Chip tone={secretsTone}>{secrets}</Chip>
            <Chip tone="line">{PROXY[s.proxy] ?? s.proxy}</Chip>
            {s.lastOkAt !== undefined && <span className="mffai-k">{`最后在线 ${fmtRelTime(s.lastOkAt, Date.now())}`}</span>}
            {s.undelivered > 0 && <Chip tone="warn">{`未送达 ${s.undelivered}`}</Chip>}
            {s.problems.map((p) => <CodeChip key={p} code={p} />)}
            {s.state === 'conflict' && <button className="set-btn" disabled={busy} onClick={clearWebhook}>清除 webhook</button>}
            <FailChip failure={failure} />
          </div>
        </div>
        {enable}
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
    <div className="mffai-row mffai-tg-token">
      <span className="mffai-tg-lab">令牌</span>
      <input ref={input} type="password" aria-label="令牌" autoComplete="off" spellCheck={false}
        onChange={(e) => { setHasText(e.target.value.length > 0); setSaved(null) }} />
      <button className="set-btn mffai-primary" disabled={!hasText || busy} onClick={save}>保存令牌</button>
      {saved && <Chip tone="ok">{`@${saved}`}</Chip>}
      {s.tokenSet && <button className="set-btn mffai-danger" disabled={busy} onClick={() => setConfirming(true)}>清除令牌</button>}
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

function useSend(saver: ConfigSaver) {
  const [failure, setFailure] = useState<SaveFailure | null>(null)
  const send = async (patch: Partial<FullConfig>) => {
    setFailure(null)
    const out = await saver.save(patch)
    if (out !== 'ok' && out !== 'skipped') setFailure(out)
  }
  return { send, failure }
}

function EnableSwitch({ config, saver }: { config: FullConfig; saver: ConfigSaver }) {
  const { send, failure } = useSend(saver)
  return (
    <>
      <SaveFailureChip failure={failure} />
      <label className="mffai-switch">
        <span className="mffai-sr">启用</span>
        <input type="checkbox" role="switch" checked={config.enabled} disabled={saver.busy} onChange={(e) => void send({ enabled: e.target.checked })} />
      </label>
    </>
  )
}

function Minutes({ config, saver }: { config: FullConfig; saver: ConfigSaver }) {
  const [minutes, setMinutes] = useState(String(config.staleMinutes))
  useEffect(() => { setMinutes(String(config.staleMinutes)) }, [config.staleMinutes])
  const { send, failure } = useSend(saver)
  const { busy } = saver
  const n = Number(minutes)
  const minutesOk = minutes.trim() !== '' && Number.isFinite(n) && n !== config.staleMinutes
  return (
    <div className="mffai-row mffai-tg-minutes">
      <label className="mffai-field">
        过期(分钟)
        <input type="number" min={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
      </label>
      <button className="set-btn" disabled={!minutesOk || busy} onClick={() => void send({ staleMinutes: n })}>保存分钟</button>
      <SaveFailureChip failure={failure} />
    </div>
  )
}

function Paired({ s, onChanged }: { s: TelegramStatus; onChanged: () => void }) {
  const retry = useRef(retryable()).current
  const [target, setTarget] = useState<{ accountId: string; name: string } | null>(null)
  const { run, busy, failure, alive } = useAction()
  // 解除或重新配对之后,超时没答的那个 commandId 不能再重放
  useMffaiEvent({ types: ['channel.paired', 'channel.unpaired'] }, (e) => { retry.done((e.payload as { accountId: string }).accountId) })
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
    <div className="mffai-tgcard mffai-paired">
      {s.paired.map((p) => (
        <div key={p.accountId} className="mffai-row">
          <span className="mffai-tg-av" aria-hidden="true">{Array.from(p.name)[0]}</span>
          <span>{p.name}</span>
          <span className="mffai-k mffai-mono">{fmtRelTime(p.pairedAt, Date.now())}</span>
          <span className="mffai-spring" />
          <button className="set-btn mffai-danger" onClick={() => setTarget({ accountId: p.accountId, name: p.name })}>撤销</button>
        </div>
      ))}
      {target && (
        <Confirm title="撤销配对" rows={[['账号', target.name]]} confirmLabel="撤销" danger busy={busy}
          onCancel={() => setTarget(null)} onConfirm={unpair}>
          <FailChip failure={failure} />
        </Confirm>
      )}
    </div>
  )
}

function Chats({ chats }: { chats: TelegramChats['chats'] }) {
  return (
    <div className="mffai-tgcard mffai-tg-chats">
      {chats.map((c) => (
        <div key={c.chatId} className="mffai-row" data-testid="mffai-tg-chat">
          <Icon name="send" size={14} />
          <button className="txt-btn mffai-tlink" onClick={() => route.set({ page: 'chat', sessionId: c.sessionId })}>{c.sessionId}</button>
          <span className="mffai-spring" />
          {c.project && <CodeChip code={c.project} />}
          {c.model && <span className="mffai-model">{c.model.modelId}</span>}
          {c.running && <Chip tone="run" dot>运行中</Chip>}
          {c.queued > 0 && <Chip tone="line">{`排队 ${c.queued}`}</Chip>}
        </div>
      ))}
    </div>
  )
}

const Group = ({ title, count, children }: { title: string; count?: number; children: ReactNode }) => (
  <section className="mffai-tgroup">
    <div className="mffai-sech">
      <span>{title}</span>
      {count !== undefined && <span className="mffai-count">{count}</span>}
    </div>
    {children}
  </section>
)

export function Telegram() {
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [statusFail, setStatusFail] = useState<'unsupported' | 'failed' | null>(null)
  const [config, setConfig] = useState<FullConfig | null>(null)
  const configRef = useRef<FullConfig | null>(null)
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
  const loadConfig = useCallback(() => call('channel.telegram.config.get', {}).then(
    (r) => {
      configRef.current = r as FullConfig
      if (alive.current) setConfig(r as FullConfig)
    },
    (e) => console.error('mffai channel.telegram.config.get', toCallError(e).code),
  ), [])
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
  const loadAll = useCallback(() => { loadStatus(); void loadConfig(); loadChats(); loadLevel() }, [loadStatus, loadConfig, loadChats, loadLevel])
  useEffect(loadAll, [loadAll])

  useMffaiEvent({ types: ['channel.status', 'channel.paired', 'channel.unpaired', 'channel.pairing.burned', 'channel.worktree.merged'] }, () => {
    loadStatus()
    loadChats()
  })
  useMffaiEvent({ types: ['permissions.updated'] }, loadLevel)
  useMffaiReset(loadAll)

  // 一个保存器给 启用、过期分钟、项目:保存完先重取配置,下一次才能开始
  const saver = useConfigSaver(() => configRef.current, async () => { loadStatus(); await loadConfig() })

  if (statusFail === 'unsupported') return <div className="mffai-conn mffai-tg"><Chip tone="bad">不支持</Chip></div>
  return (
    <div className="mffai-conn mffai-tg">
      {statusFail === 'failed' && <span className="mffai-fail">失败</span>}
      <div className="mffai-tg-cols">
        <div className="mffai-tg-left">
          {status && (
            <div className="mffai-tgcard mffai-tg-status">
              <StatusRow s={status} onChanged={loadStatus} enable={config && <EnableSwitch config={config} saver={saver} />} />
              <Token s={status} onChanged={loadStatus} />
              {config && <Minutes config={config} saver={saver} />}
            </div>
          )}
          {status && status.paired.length > 0 && <Group title="已配对" count={status.paired.length}><Paired s={status} onChanged={loadStatus} /></Group>}
        </div>
        <div className="mffai-tg-right">
          {status && <Pairing active={status.pairing.active} onChanged={loadStatus} />}
          {config && <Projects config={config} level={level} saver={saver} />}
          {chats.length > 0 && <Group title="聊天" count={chats.length}><Chats chats={chats} /></Group>}
        </div>
      </div>
    </div>
  )
}
