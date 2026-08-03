import { useEffect, useState } from 'react'
import type { Settings, BotStatus, BotPlatform } from '@shared/types'
import './botpane.css'

type BotConfig = Settings['botBridge']

interface BotPaneProps {
  config: BotConfig
  onChange: (bb: BotConfig) => void
}

const STATUS_LABEL: Record<BotStatus['state'], string> = {
  offline: '未连接', connecting: '连接中…', online: '在线', error: '连接失败',
}

const VERBOSITY: { key: BotConfig['verbosity']; label: string; hint: string }[] = [
  { key: 'essential', label: '只推关键', hint: '仅推「需你应答」的门 + 完成/失败摘要（推荐）' },
  { key: 'stages', label: '加阶段', hint: '再加上工作流阶段切换' },
  { key: 'verbose', label: '全推', hint: '再加上实时日志（手机会较刷屏）' },
]

const COMMANDS: { cmd: string; desc: string }[] = [
  { cmd: 'list', desc: '列出工作区与会话' },
  { cmd: 'attach <id>', desc: '选定焦点（s<n>=会话，w<n>=工作区取活动会话）' },
  { cmd: 'new [w<id>] [标题]', desc: '在工作区新建并 attach 一个会话' },
  { cmd: 'model [名称]', desc: '查看/切换模型（model o3 或 model 2）' },
  { cmd: 'perm [值]', desc: '切权限：readonly / auto / full（只读/自动/完全）' },
  { cmd: 'status', desc: '查看当前焦点与待处理' },
  { cmd: 'stop', desc: '停止当前焦点会话' },
  { cmd: 'unbind', desc: '解绑本聊天' },
]

// Per-platform credential field definitions — a platform is just a name + a set of text/secret fields
// keyed into its config slot, so the section renderer is generic.
interface Field { key: string; label: string; secret?: boolean; placeholder?: string }
const PLATFORMS: { id: BotPlatform; name: string; hint: string; fields: Field[] }[] = [
  {
    id: 'dingtalk', name: '钉钉', hint: '钉钉开放平台建「企业内部应用」，开启机器人 + Stream Mode，填 Client ID / Secret。',
    fields: [{ key: 'clientId', label: 'Client ID', placeholder: 'dingxxxxxxxx' }, { key: 'clientSecret', label: 'Client Secret', secret: true }],
  },
  {
    id: 'telegram', name: 'Telegram', hint: '找 @BotFather 建 bot 拿 token（无需公网，长轮询）。',
    fields: [{ key: 'botToken', label: 'Bot Token', secret: true, placeholder: '123456:ABC-DEF…' }],
  },
  {
    id: 'feishu', name: '飞书', hint: '飞书开放平台建「企业自建应用」，开启长连接，填 App ID / Secret。需安装 SDK：npm i @larksuiteoapi/node-sdk。',
    fields: [{ key: 'appId', label: 'App ID', placeholder: 'cli_xxxxxxxx' }, { key: 'appSecret', label: 'App Secret', secret: true }],
  },
]

function PlatformSection({ def, slot, statuses, onChange, onConnect, onDisconnect }: {
  def: typeof PLATFORMS[number]
  slot: Record<string, unknown>
  statuses: Record<string, BotStatus>
  onChange: (patch: Record<string, unknown>) => void
  onConnect: (p: BotPlatform) => void
  onDisconnect: (p: BotPlatform) => void
}) {
  const [local, setLocal] = useState<Record<string, string>>(() =>
    Object.fromEntries(def.fields.map(f => [f.key, String(slot[f.key] ?? '')])))
  useEffect(() => { setLocal(Object.fromEntries(def.fields.map(f => [f.key, String(slot[f.key] ?? '')]))) },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    def.fields.map(f => slot[f.key]))

  const status = statuses[def.id] ?? { state: 'offline' as const }
  const online = status.state === 'online' || status.state === 'connecting'
  const dirty = def.fields.some(f => local[f.key] !== String(slot[f.key] ?? ''))
  const filled = def.fields.every(f => local[f.key].trim())
  const save = () => onChange(Object.fromEntries(def.fields.map(f => [f.key, local[f.key].trim()])))

  return (
    <div className="set-group bot-platform">
      <div className="bot-platform-head">
        <h4>{def.name}</h4>
        <span className={`bot-status ${status.state}`}>
          <span className="dot" />{STATUS_LABEL[status.state]}
          {status.state === 'error' && <span>：{status.reason}</span>}
        </span>
      </div>
      <p className="set-desc">{def.hint}</p>
      <div className={`bot-fields cols-${def.fields.length}`}>
        {def.fields.map(f => (
          <div className="proj-field" style={{ marginBottom: 0 }} key={f.key}>
            <label htmlFor={`bot-${def.id}-${f.key}`}>{f.label}</label>
            <input id={`bot-${def.id}-${f.key}`} type={f.secret ? 'password' : 'text'} spellCheck={false} autoComplete="off"
              placeholder={f.placeholder} value={local[f.key]} onChange={e => setLocal(s => ({ ...s, [f.key]: e.target.value }))} />
          </div>
        ))}
      </div>
      <div className="bot-actions">
        <button className="set-btn" onClick={save} disabled={!dirty}>保存</button>
        {online
          ? <button className="set-btn danger" onClick={() => onDisconnect(def.id)}>断开</button>
          : <button className="set-btn primary" onClick={() => onConnect(def.id)} disabled={!filled || dirty}>连接</button>}
        {dirty && <span className="bot-warn">先保存再连接</span>}
      </div>
    </div>
  )
}

export function BotPane({ config, onChange }: BotPaneProps) {
  const [statuses, setStatuses] = useState<Record<string, BotStatus>>({})

  useEffect(() => {
    void window.forge.botGetStatus().then(setStatuses)
    const off = window.forge.onBotStatus((e) => setStatuses(s => ({ ...s, [e.platform]: e.status })))
    return () => { off() }
  }, [])

  const connect = async (p: BotPlatform) => setStatuses(await window.forge.botConnect(p))
  const disconnect = async (p: BotPlatform) => setStatuses(await window.forge.botDisconnect(p))
  const regen = async () => { await window.forge.botRegenPairing() }
  const unbind = async (chatId: string) => { await window.forge.botUnbind(chatId) }

  const platName = (p: string) => PLATFORMS.find(x => x.id === p)?.name ?? p

  return (
    <div className="bot-pane">
      <div className="set-group">
        <h4>机器人桥</h4>
        <p className="set-desc">
          把 App 的待确认、待输入、工作流门、完成摘要推到手机；在聊天里回复即可应答，也能发起新对话、切模型/权限。
          凭据只保存在本机，不上传、不进代码库。下面每个平台可分别启用。
        </p>
      </div>

      {PLATFORMS.map(def => (
        <PlatformSection key={def.id} def={def} slot={config[def.id] as unknown as Record<string, unknown>}
          statuses={statuses}
          onChange={(patch) => onChange({ ...config, [def.id]: { ...config[def.id], ...patch } })}
          onConnect={connect} onDisconnect={disconnect} />
      ))}

      <div className="set-group">
        <h4>配对</h4>
        <p className="set-desc">在任一已连接的机器人里私聊它，发送 <b>bind {config.pairingCode || '——'}</b> 完成绑定（配对码单次有效，绑定后自动更换）。</p>
        <div className="bot-pair">
          <span className="bot-code">{config.pairingCode || '——'}</span>
          <button className="set-btn" onClick={regen}>重新生成</button>
        </div>
      </div>

      <div className="set-group">
        <h4>推送粒度</h4>
        <div className="bot-radios">
          {VERBOSITY.map(v => (
            <label key={v.key} className={`bot-radio${config.verbosity === v.key ? ' on' : ''}`}>
              <input type="radio" name="bot-verbosity" checked={config.verbosity === v.key}
                onChange={() => onChange({ ...config, verbosity: v.key })} />
              <span><span className="t">{v.label}</span><span className="d">{v.hint}</span></span>
            </label>
          ))}
        </div>
      </div>

      <div className="set-group">
        <h4>已绑定的聊天（{config.bindings.length}）</h4>
        {config.bindings.length === 0
          ? <div className="bot-empty">还没有绑定。按上面的配对步骤在机器人里绑定。</div>
          : config.bindings.map(b => (
            <div key={b.chatId} className="bot-bind">
              <div>
                <div className="who">{platName(b.platform)} · {b.chatType === 'private' ? '私聊' : '群'} · {b.userId || b.chatId}</div>
                <div className="sub">焦点：{b.focus ? b.focus.sessionId : '未设置（在聊天里发 list / attach）'}</div>
              </div>
              <button className="set-btn danger" onClick={() => unbind(b.chatId)}>解绑</button>
            </div>
          ))}
      </div>

      <div className="set-group">
        <h4>聊天里可用指令</h4>
        <ul className="bot-cmds">
          {COMMANDS.map(c => (<li key={c.cmd}><code>{c.cmd}</code><span>{c.desc}</span></li>))}
        </ul>
        <p className="bot-note">
          有待处理门时直接回复即作答（<b>allow</b> / <b>deny</b>、序号、或文本）；否则直接发消息 = 给焦点会话开新对话。
        </p>
      </div>
    </div>
  )
}
