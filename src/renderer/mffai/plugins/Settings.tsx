// 插件配置(08 §13.3,09 §8.3):每个键一行 + 一个输入框;敏感的是密码框,只显示 已设置 / 未设置 和 清除。
// 保存走 plugins.settings.set(没有 commandId:带了就进回执库),成功后清空输入框。值不进 React state、
// 不进日志(出错只记方法和错误码)、不进存储:输入框不受控,只在点保存时读一次。
import { useRef, useState } from 'react'
import type { PluginConsent, PluginDetail } from '@mffai/protocol'
import { call } from '../rpc'
import { Chip } from '../ui/Chip'
import { PText } from '../ui/PText'
import { FailChip, useAction } from './action'

type Setting = PluginDetail['settings'][number]
type Config = PluginConsent['config'][number]

function SettingRow({ id, s, c, onChanged }: { id: string; s: Setting; c?: Config; onChanged: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [hasText, setHasText] = useState(false)
  const { run, busy, failure, alive } = useAction()

  const save = () => void run('plugins.settings.set', async () => {
    const value = input.current?.value ?? ''
    if (!value) return
    await call('plugins.settings.set', { id, key: s.key, value })
    if (input.current) input.current.value = ''
    if (!alive.current) return
    setHasText(false)
    onChanged()
  })
  const clear = () => void run('plugins.settings.clear', async () => {
    await call('plugins.settings.clear', { id, key: s.key })
    if (alive.current) onChanged()
  })

  return (
    <div className="mffai-row mffai-crow" data-setting={s.key}>
      <PText text={s.key} mono />
      {c && <PText text={c.title} />}
      {s.sensitive && <Chip tone="warn">敏感</Chip>}
      {c?.required && <Chip>必填</Chip>}
      {c && <PText text={c.type} mono />}
      {s.sensitive
        ? <Chip tone={s.set ? 'ok' : 'muted'}>{s.set ? '已设置' : '未设置'}</Chip>
        : s.value !== undefined && <PText text={s.value} mono />}
      <input ref={input} type={s.sensitive ? 'password' : 'text'} aria-label={s.key} autoComplete="off" spellCheck={false}
        onChange={(e) => setHasText(e.target.value.length > 0)} />
      <button className="set-btn" disabled={busy || !hasText} onClick={save}>保存</button>
      {s.set && <button className="set-btn" disabled={busy} onClick={clear}>清除</button>}
      <FailChip failure={failure} />
    </div>
  )
}

export function Settings({ id, config, settings, onChanged }: {
  id: string
  config: readonly Config[]
  settings: readonly Setting[]
  onChanged: () => void
}) {
  if (settings.length === 0) return null
  return (
    <div className="mffai-group" data-section="settings">
      <div className="mffai-grouphead"><span>配置</span></div>
      {settings.map((s) => <SettingRow key={s.key} id={id} s={s} c={config.find((c) => c.key === s.key)} onChanged={onChanged} />)}
    </div>
  )
}
