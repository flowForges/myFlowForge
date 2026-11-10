import { useRef, useState } from 'react'
import { AddAccount } from './AddAccount'
import { modelsOf, useModels } from './useModels'
import { AccountCard } from './conn/AccountCard'
import { AddAccountDrawer } from './conn/AddAccountDrawer'
import { Chip } from './ui/Chip'
import { Icon } from './shell/icons'

/** auth.chatgpt.begin 不带账号 id,重登的是第一个坏掉的 ChatGPT 账号:只给一个按钮,在账号列表上面 */
function Relogin() {
  const [loggingIn, setLoggingIn] = useState(false)
  const [failed, setFailed] = useState(false)
  const loginRef = useRef(false)
  const relogin = () => {
    if (loginRef.current) return
    loginRef.current = true
    setFailed(false)
    setLoggingIn(true)
    void window.forge.mffai.chatgpt.begin()
      .catch((e) => { console.error('mffai', e); setFailed(true) })
      .finally(() => { loginRef.current = false; setLoggingIn(false) })
  }
  return (
    <div className="mffai-actions mffai-relogin">
      <button className="set-btn" disabled={loggingIn} onClick={relogin}>重新登录</button>
      {failed && <span className="mffai-fail">失败</span>}
    </div>
  )
}

export function Connections() {
  const { catalog, accounts, backend, reload } = useModels()
  const [drawer, setDrawer] = useState(false)
  const needsLogin = accounts.some((a) => a.state === 'needs_login' && catalog?.presets.find((p) => p.id === a.presetId)?.auth === 'chatgpt-oauth')
  const presets = catalog?.presets ?? []
  return (
    <div className="mffai-conn">
      <div className="mffai-sech">
        <span className="mffai-tcard-title">账号</span>
        <span className="mffai-count">{accounts.length}</span>
        {backend === 'keychain' && <Chip tone="ok" sq><Icon name="lock" />钥匙串</Chip>}
        {backend === 'plaintext-file' && <span className="mffai-badge">明文存储</span>}
        {(backend === 'unavailable' || backend === 'unreadable') && <span className="mffai-badge">钥匙串不可用</span>}
        <span className="mffai-spring" />
        <button className="set-btn mffai-primary" onClick={() => setDrawer(true)} disabled={!presets.length}><Icon name="plus" size={13} />添加账号</button>
      </div>
      {needsLogin && <Relogin />}
      <div className="mffai-agrid">
        {accounts.map((a) => {
          const isDefault = catalog?.default?.accountId === a.id
          return (
            <AccountCard key={a.id} account={a} preset={catalog?.presets.find((p) => p.id === a.presetId)}
              models={modelsOf(catalog, a)} defaultModelId={isDefault ? catalog?.default?.modelId : undefined}
              isDefault={isDefault} onChanged={reload} />
          )
        })}
      </div>
      <AddAccountDrawer open={drawer} onClose={() => setDrawer(false)}>
        <AddAccount presets={presets} onDone={() => { setDrawer(false); reload() }} onClose={() => setDrawer(false)} />
      </AddAccountDrawer>
    </div>
  )
}
