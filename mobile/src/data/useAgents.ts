import { useEffect, useState } from 'react'
import { CH } from '../../../src/main/ipc/channels'
import { useConn } from '../net/conn'

/**
 * 这台**远程主机**上装了哪些编码代理、各自有哪些模型。
 *
 * ★一律现问,绝不预置。模型列表是每台机器的本地事实(装了哪个版本、登录的是哪个账号),
 *  硬编码一份在手机里,出个新模型就得发新版 app。
 */
export type AgentModel = { id: string; label: string; description?: string }
export type AgentInfo = {
  id: string
  displayName: string
  installed: boolean
  models: AgentModel[]
}

export function useAgents() {
  const { invoke, online, epoch } = useConn()
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!online) {
      setAgents([])
      return
    }
    let alive = true
    setLoading(true)
    void (async () => {
      try {
        const list = (await invoke(CH.agentsDetect, [])) as AgentInfo[]
        if (!alive) return
        setAgents(Array.isArray(list) ? list.filter((a) => a.installed) : [])
      } catch {
        // 探测失败不该拦住整个界面 —— 没探到就是没探到,选择器会显示空。
        if (alive) setAgents([])
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [invoke, online, epoch])

  return { agents, loading }
}
