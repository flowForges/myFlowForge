// 我方正在跑的轮次登记(进程内):哪个 Forge 会话此刻有一轮在途。一轮结束后留驻的 claude 进程不算 ——
// 那时用户可能正在官方 App 里用同一个会话,占用要照常看文件。

const live = new Map<string, number>()
const key = (ws: string, sid: string, agent: string) => `${ws}\0${sid}\0${agent}`

/** 一轮开始;返回结束函数(可重复调用)。同一会话可以叠(收养的那一轮)。 */
export function beginOwnTurn(ws: string, sid: string, agent: string): () => void {
  const k = key(ws, sid, agent)
  live.set(k, (live.get(k) ?? 0) + 1)
  let ended = false
  return () => {
    if (ended) return
    ended = true
    const n = (live.get(k) ?? 1) - 1
    if (n > 0) live.set(k, n); else live.delete(k)
  }
}
export function isOwnTurnLive(ws: string, sid: string, agent: string): boolean { return live.has(key(ws, sid, agent)) }
/** 此刻有轮次在途的 (ws, sid),只列这个 agent 的。 */
export function liveTurnSessions(agent: string): Array<{ ws: string; sid: string }> {
  const out: Array<{ ws: string; sid: string }> = []
  for (const k of live.keys()) { const [ws, sid, a] = k.split('\0'); if (a === agent) out.push({ ws, sid }) }
  return out
}
