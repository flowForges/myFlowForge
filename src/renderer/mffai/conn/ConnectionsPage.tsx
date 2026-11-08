// 连接页(08 §10):三个子页 模型 / 执行器 / Telegram。
import { useState } from 'react'
import { Connections } from '../Connections'
import { Executors } from './Executors'
import { Telegram } from './Telegram'

type Tab = 'model' | 'exec' | 'telegram'
const TABS: [Tab, string][] = [['model', '模型'], ['exec', '执行器'], ['telegram', 'Telegram']]

export default function ConnectionsPage() {
  const [tab, setTab] = useState<Tab>('model')
  return (
    <div className="mffai-pane mffai-conn-page">
      <div className="mffai-tabs" role="tablist">
        {TABS.map(([id, name]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`set-btn${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>{name}</button>
        ))}
      </div>
      {tab === 'model' && <Connections />}
      {tab === 'exec' && <Executors />}
      {tab === 'telegram' && <Telegram />}
    </div>
  )
}
