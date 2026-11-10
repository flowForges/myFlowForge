// 输入框(08 §7.4)。不复用 app 的 Composer:textarea,回车发送,Shift+回车换行,没有 placeholder。
// `/` 打开 plugins.commands 的菜单(名字、插件、argumentHint 放在 CodeChip 里);选中后回车走 plugins.command.run。
// 来源不是 app 的会话没有输入框(R5):一行来源块 + 停止。
// 08b:圆角外壳;底栏是只读的模型 / 目录 / 审批模式块(R15,来自会话已有的数据)和圆形的停止 / 发送钮;非本机会话是虚线来源条,挂起块在它上面。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionOrigin, SessionSummary, WorkerResult } from '@mffai/protocol'
import { call, isUnsupported, toCallError } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { label } from '../labels'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { Icon } from '../shell/icons'
import { OriginIcon, originKind } from './SessionList'

type PluginCommand = WorkerResult<'plugins.commands'>['commands'][number]

const ERR_BUSY = -32003
const REFRESH_ON = ['plugins.enabled', 'plugins.disabled', 'plugins.installed', 'plugins.uninstalled'] as const

// 每个后台连接(window.forge.mffai)一份缓存;不支持(-32601)就是空的。
// 挂载时先显示缓存,再重取一次:没有输入框挂着的时候(在插件页装、启用)来的变更事件这里收不到
const cache = new WeakMap<object, Promise<PluginCommand[]>>()
function loadCommands(force = false): Promise<PluginCommand[]> {
  const key = window.forge.mffai as object
  const hit = cache.get(key)
  if (hit && !force) return hit
  const p = call('plugins.commands').then(
    (r) => r.commands,
    (e) => {
      if (isUnsupported(e)) return [] as PluginCommand[]
      console.error('mffai plugins.commands', e)
      // 重取失败:留着上一份(没有就是空的),下次再取
      if (cache.get(key) === p) { if (hit) cache.set(key, hit); else cache.delete(key) }
      return hit ?? ([] as PluginCommand[])
    },
  )
  cache.set(key, p)
  return p
}

function cachedCommands(): Promise<PluginCommand[]> | undefined {
  return cache.get(window.forge.mffai as object)
}

function usePluginCommands(): PluginCommand[] {
  const [list, setList] = useState<PluginCommand[]>([])
  const alive = useRef(true)
  // 按发起顺序编号,只往前走:慢的缓存读或更早的重取后到,不会盖掉已经显示的更新的结果
  const gen = useRef(0)
  const shown = useRef(0)
  const apply = (p: Promise<PluginCommand[]>) => {
    const g = ++gen.current
    void p.then((l) => {
      if (!alive.current || g < shown.current) return
      shown.current = g
      setList(l)
    })
  }
  useEffect(() => {
    alive.current = true
    const hit = cachedCommands()
    if (hit) apply(hit)
    apply(loadCommands(true))
    return () => { alive.current = false }
  }, [])
  useMffaiEvent({ types: REFRESH_ON }, () => apply(loadCommands(true)))
  useMffaiReset(() => apply(loadCommands(true)))
  return list
}

/** 只有 `/词`、还没打空格时开菜单 */
const SLASH = /^\/(\S*)$/
const COMMAND = /^\/(\S+)(?:\s+([\s\S]*))?$/

/** 路径的最后一段(底栏只放目录名,全路径在 title 里) */
const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

export function MffaiComposer({ session, imName, onSend, onCommand, onStop, canStop, parked, readOnly, info }: {
  session: Pick<SessionSummary, 'id' | 'origin'>
  /** IM 会话的 Telegram 名字 */
  imName?: string
  onSend: (text: string) => Promise<unknown>
  onCommand: (name: string, args: string) => Promise<unknown>
  onStop: () => void
  canStop: boolean
  /** 挂起的轮;running 是还在跑的委派运行数 */
  parked?: { running?: number }
  /** 会话已删、后台没连上 */
  readOnly?: boolean
  /** 底栏的只读块:给了哪个显示哪个 */
  info?: { model?: string; cwd?: string; mode?: 'ask' | 'auto' }
}) {
  const commands = usePluginCommands()
  const [text, setText] = useState('')
  const inflight = useRef(false)
  const [err, setErr] = useState<'busy' | 'failed' | null>(null)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const q = SLASH.exec(text)?.[1]
  const matches = useMemo(() => {
    if (q === undefined) return []
    const needle = q.toLowerCase()
    return commands.filter((c) => c.name.toLowerCase().includes(needle))
  }, [q, commands])
  const menuOpen = !dismissed && matches.length > 0
  const sel = Math.min(active, Math.max(0, matches.length - 1))

  const edit = (v: string) => {
    setText(v)
    setErr(null)
    setDismissed(false)
    setActive(0)
  }
  const pick = (c: PluginCommand) => edit(`/${c.name} `)

  const send = async () => {
    const t = text.trim()
    if (!t || inflight.current || readOnly) return
    const m = COMMAND.exec(t)
    const cmd = m && commands.find((c) => c.name === m[1])
    inflight.current = true
    setErr(null)
    setText('')
    try {
      if (cmd) await onCommand(cmd.name, (m[2] ?? '').trim())
      else await onSend(t)
    } catch (e) {
      if (!alive.current) return
      // 文字放回去;打字期间又写了的接在后面
      setText((cur) => (cur ? `${t}\n${cur}` : t))
      setErr(toCallError(e).code === ERR_BUSY ? 'busy' : 'failed')
    } finally {
      inflight.current = false
    }
  }

  const parkedChip = parked && <Chip tone="warn">{parked.running !== undefined ? `挂起 · ${parked.running} 运行中` : '挂起'}</Chip>

  const origin: SessionOrigin = originKind(session.origin)
  if (origin !== 'app') {
    return (
      <div className="mffai-composer mffai-composer-ro">
        {parked && <div className="mffai-composer-top">{parkedChip}</div>}
        <div className="mffai-srcbar">
          <OriginIcon origin={origin} />
          <Chip tone="line">{origin === 'im' ? `Telegram${imName ? ` · ${imName}` : ''}` : label('origin', origin)}</Chip>
          <span className="mffai-spring" />
          {canStop && <button className="set-btn mffai-xs" onClick={onStop}><Icon name="pause" size={12} />停止</button>}
        </div>
      </div>
    )
  }

  return (
    <div className="mffai-composer">
      {menuOpen && (
        <ul className="slash-pop mffai-slash" role="listbox" aria-label="命令">
          {matches.map((c, i) => (
            <li key={c.name} role="option" aria-selected={i === sel} className={'slash-item' + (i === sel ? ' on' : '')}
              onMouseDown={(e) => { e.preventDefault(); pick(c) }}>
              <span className="slash-cmd mffai-slash-name">/{c.name}</span>
              {c.argumentHint && <CodeChip code={c.argumentHint} />}
              <span className="mffai-slash-about">{c.description}</span>
              <span className="slash-tag"><Icon name="puzzle" size={12} />{c.plugin}</span>
            </li>
          ))}
        </ul>
      )}
      <textarea
        className="mffai-input" aria-label="输入" rows={2} autoFocus value={text} disabled={readOnly}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (menuOpen) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((sel + 1) % matches.length); return }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((sel - 1 + matches.length) % matches.length); return }
            if (e.key === 'Escape') { e.preventDefault(); setDismissed(true); return }
            if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pick(matches[sel]); return }
          }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
        }}
      />
      <div className="mffai-composer-bar">
        {info?.model && <span className="mffai-cinfo" title={info.model}><Icon name="sparkle" size={13} />{info.model}</span>}
        {info?.cwd && <span className="mffai-cinfo" title={info.cwd}><Icon name="folder" size={13} />{base(info.cwd)}</span>}
        {info?.mode && <span className={`mffai-cinfo${info.mode === 'auto' ? ' warn' : ''}`}><Icon name={info.mode === 'auto' ? 'zap' : 'shield'} size={13} />{info.mode === 'auto' ? '自动放行' : '询问'}</span>}
        {parkedChip}
        {err === 'busy' && <Chip tone="warn">忙</Chip>}
        {err === 'failed' && <span className="mffai-fail">失败</span>}
        <span className="mffai-spring" />
        {canStop
          ? <button type="button" className="mffai-cround stop" aria-label="停止" title="停止" onClick={onStop}><i /></button>
          : <button type="button" className="mffai-cround send" aria-label="发送" title="发送" disabled={readOnly || !text.trim()} onClick={() => void send()}><Icon name="up" size={16} /></button>}
      </div>
    </div>
  )
}
