import { useEffect, useState } from 'react'
import type { Settings, BotStatus } from '@shared/types'
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

export function BotPane({ config, onChange }: BotPaneProps) {
  const [status, setStatus] = useState<BotStatus>({ state: 'offline' })
  const [clientId, setClientId] = useState(config.dingtalk.clientId)
  const [clientSecret, setClientSecret] = useState(config.dingtalk.clientSecret)
  const [busy, setBusy] = useState(false)

  useEffect(() => { setClientId(config.dingtalk.clientId); setClientSecret(config.dingtalk.clientSecret) }, [config.dingtalk.clientId, config.dingtalk.clientSecret])
  useEffect(() => {
    void window.forge.botGetStatus().then(setStatus)
    const off = window.forge.onBotStatus(setStatus)
    return () => { off() }
  }, [])

  const credsDirty = clientId !== config.dingtalk.clientId || clientSecret !== config.dingtalk.clientSecret
  const saveCreds = () => onChange({ ...config, dingtalk: { clientId: clientId.trim(), clientSecret: clientSecret.trim() } })

  const connect = async () => { setBusy(true); try { setStatus(await window.forge.botConnect()) } finally { setBusy(false) } }
  const disconnect = async () => { setBusy(true); try { setStatus(await window.forge.botDisconnect()) } finally { setBusy(false) } }
  const regen = async () => { await window.forge.botRegenPairing() /* settingsChanged refreshes config */ }
  const unbind = async (chatId: string) => { await window.forge.botUnbind(chatId) }

  const online = status.state === 'online' || status.state === 'connecting'

  return (
    <div className="bot-pane">
      <div className="set-group">
        <h4>钉钉机器人</h4>
        <p className="set-desc">
          把 App 的待确认、待输入、工作流门、完成摘要推到手机钉钉；在钉钉里回复即可应答，也能发起新对话。
          需在<b>钉钉开放平台</b>建一个「企业内部应用」，开启机器人 + Stream Mode，填入下方 Client ID / Secret。
          凭据只保存在本机，不上传、不进代码库。
        </p>
        <div style={{ marginTop: 14 }}>
          <span className={`bot-status ${status.state}`}>
            <span className="dot" />
            {STATUS_LABEL[status.state]}
            {status.state === 'error' && <span>：{status.reason}</span>}
          </span>
        </div>
      </div>

      <div className="set-group">
        <h4>凭据</h4>
        <div className="bot-fields">
          <div className="proj-field" style={{ marginBottom: 0 }}>
            <label htmlFor="bot-cid">Client ID</label>
            <input id="bot-cid" value={clientId} onChange={e => setClientId(e.target.value)} placeholder="dingxxxxxxxx" spellCheck={false} autoComplete="off" />
          </div>
          <div className="proj-field" style={{ marginBottom: 0 }}>
            <label htmlFor="bot-secret">Client Secret</label>
            <input id="bot-secret" type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} placeholder="••••••••" spellCheck={false} autoComplete="off" />
          </div>
        </div>
        <div className="bot-actions">
          <button className="set-btn" onClick={saveCreds} disabled={!credsDirty}>保存凭据</button>
          {online
            ? <button className="set-btn danger" onClick={disconnect} disabled={busy}>断开</button>
            : <button className="set-btn primary" onClick={connect} disabled={busy || !config.dingtalk.clientId}>连接</button>}
        </div>
        {credsDirty && <p className="bot-warn">凭据已修改，先「保存凭据」再连接。</p>}
      </div>

      <div className="set-group">
        <h4>配对</h4>
        <p className="set-desc">在钉钉里私聊机器人，发送 <b>bind {config.pairingCode || '——'}</b> 完成绑定（配对码单次有效，绑定后自动更换）。</p>
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
              <span>
                <span className="t">{v.label}</span>
                <span className="d">{v.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="set-group">
        <h4>已绑定的聊天（{config.bindings.length}）</h4>
        {config.bindings.length === 0
          ? <div className="bot-empty">还没有绑定。按上面的配对步骤在钉钉里绑定。</div>
          : config.bindings.map(b => (
            <div key={b.chatId} className="bot-bind">
              <div>
                <div className="who">{b.chatType === 'private' ? '私聊' : '群'} · {b.userId || b.chatId}</div>
                <div className="sub">焦点：{b.focus ? b.focus.sessionId : '未设置（在钉钉发 list / attach）'}</div>
              </div>
              <button className="set-btn danger" onClick={() => unbind(b.chatId)}>解绑</button>
            </div>
          ))}
      </div>

      <div className="set-group">
        <h4>钉钉里可用指令</h4>
        <ul className="bot-cmds">
          {COMMANDS.map(c => (
            <li key={c.cmd}><code>{c.cmd}</code><span>{c.desc}</span></li>
          ))}
        </ul>
        <p className="bot-note">
          有待处理门时直接回复即作答（<b>allow</b> / <b>deny</b>、序号、或文本）；否则直接发消息 = 给焦点会话开新对话。
        </p>
      </div>
    </div>
  )
}
