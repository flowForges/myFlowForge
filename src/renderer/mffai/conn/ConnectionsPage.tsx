// 连接页(08 §10):三个子页 模型 / 执行器 / Telegram。
import { useState } from 'react'
import { Connections } from '../Connections'
import { Executors } from './Executors'
import { Telegram } from './Telegram'
import { Icon, type IconName } from '../shell/icons'

type Tab = 'model' | 'exec' | 'telegram'
const TABS: [Tab, string, IconName][] = [['model', '模型', 'key'], ['exec', '执行器', 'bot'], ['telegram', 'Telegram', 'send']]

export default function ConnectionsPage() {
  const [tab, setTab] = useState<Tab>('model')
  return (
    <div className="mffai-pane mffai-conn-page">
      <div className="mffai-tabs" role="tablist">
        {TABS.map(([id, name, icon]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`set-btn${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}><Icon name={icon} size={14} />{name}</button>
        ))}
      </div>
      {tab === 'model' && <Connections />}
      {tab === 'exec' && <Executors />}
      {tab === 'telegram' && <Telegram />}
    </div>
  )
}
