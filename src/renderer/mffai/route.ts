// mff-ai 页面路由(08 §6.1)。★不 import 任何东西:页面之间互相跳转只经它。

export const MFFAI_PAGES = ['chat', 'tasks', 'memory', 'plugins', 'conn', 'perm', 'debug'] as const
export type MffaiPage = (typeof MFFAI_PAGES)[number]
/** newSession:打开新会话表单并预填(Task 12、13);runId:滚到那张运行卡片(Task 6 的 `去合并`) */
export type MffaiRoute = { page: MffaiPage; sessionId?: string; runId?: string; newSession?: { cwd?: string } }

let current: MffaiRoute = { page: 'chat' }
const subs = new Set<(r: MffaiRoute) => void>()

const copy = (r: MffaiRoute): MffaiRoute => ({ ...r, ...(r.newSession && { newSession: { ...r.newSession } }) })

export const route = {
  get: (): MffaiRoute => current,
  set(r: MffaiRoute): void {
    current = copy(r)
    for (const cb of [...subs]) cb(current)
  },
  subscribe(cb: (r: MffaiRoute) => void): () => void {
    subs.add(cb)
    return () => { subs.delete(cb) }
  },
}
