// Short, persistent, monotonic addressing ids for the bot bridge: workspaces get `w<n>`, sessions get
// `s<n>`. A single global seq means numbers never collide across the two namespaces (w3 and s3 can't
// both exist). Ids are never reused — deleting a workspace/session does not recycle its number. State
// lives in BotBridgeConfig.ids and is persisted by the caller via `persist`.

import type { BotBridgeConfig } from './botTypes'

type IdState = BotBridgeConfig['ids']

export class IdRegistry {
  constructor(private state: IdState, private persist: () => void) {}

  private assign(map: Record<string, string>, key: string, prefix: 'w' | 's'): string {
    const existing = map[key]
    if (existing) return existing
    const id = `${prefix}${++this.state.seq}`
    map[key] = id
    this.persist()
    return id
  }

  idForWs(path: string): string { return this.assign(this.state.ws, path, 'w') }
  idForSession(sessionId: string): string { return this.assign(this.state.session, sessionId, 's') }

  resolveWs(shortId: string): string | null {
    for (const [path, id] of Object.entries(this.state.ws)) if (id === shortId) return path
    return null
  }
  resolveSession(shortId: string): string | null {
    for (const [sid, id] of Object.entries(this.state.session)) if (id === shortId) return sid
    return null
  }
}
