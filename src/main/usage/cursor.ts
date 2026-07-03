import { join } from 'node:path'
import { homedir } from 'node:os'
import type { HttpClient, StatusbarUsage } from './types'
import { normalizeWindow } from './normalize'

export function normalizeCursor(raw: unknown, nowMs: number): StatusbarUsage {
  const window5h = normalizeWindow(raw, nowMs)
  return { ...(window5h ? { window5h } : {}), label: 'Cursor' }
}

interface TokenDeps { runSqlite: (dbPath: string) => string; home?: string }

export function readCursorToken(deps: TokenDeps): string {
  const db = join(deps.home ?? homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  let tok = ''
  try {
    tok = deps.runSqlite(db)
  } catch {
    throw new Error('Cursor 未登录')
  }
  if (!tok) throw new Error('Cursor 未登录')
  return tok
}

export async function fetchCursorUsage(http: HttpClient, deps?: TokenDeps, cred?: string): Promise<StatusbarUsage> {
  // A user-pasted WorkosCursorSessionToken (设置→插件→凭据) bypasses the sqlite read entirely.
  const token = cred?.trim() || (deps ? readCursorToken(deps) : '')
  if (!token) throw new Error('Cursor 未登录')
  const raw = await http.getJson('https://cursor.com/api/usage-summary', {
    cookie: `WorkosCursorSessionToken=${token}`,
  })
  return normalizeCursor(raw, Date.now())
}
