import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DiscoveredSession, ImportedMessage } from '@shared/types'
import type { SessionSource } from './claude'
import { decodeDirCwd } from '../types'

interface Parsed { who?: 'user' | 'ai'; text?: string }
function blockText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
}
function stripTags(t: string): string { return t.replace(/<\/?[a-z_]+>/gi, '').replace(/\s+/g, ' ').trim() }
export function parseCursorLine(line: string): Parsed {
  let o: any
  try { o = JSON.parse(line) } catch { return {} }
  if (o.role === 'user') return { who: 'user', text: stripTags(blockText(o.message?.content)) }
  if (o.role === 'assistant') return { who: 'ai', text: blockText(o.message?.content) }
  return {}
}
function clip(t: string): string { const s = t.replace(/\s+/g, ' ').trim(); return s.length > 40 ? s.slice(0, 40) + '…' : (s || '历史会话') }

export const cursorSource: SessionSource = {
  id: 'cursor',
  scan(roots) {
    const out: DiscoveredSession[] = []
    if (!roots.cursor || !existsSync(roots.cursor)) return out
    for (const dir of readdirSync(roots.cursor, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const tDir = join(roots.cursor, dir.name, 'agent-transcripts')
      if (!existsSync(tDir)) continue
      const cwd = decodeDirCwd(dir.name)
      for (const sess of readdirSync(tDir, { withFileTypes: true })) {
        if (!sess.isDirectory()) continue
        const full = join(tDir, sess.name, `${sess.name}.jsonl`)
        if (!existsSync(full)) continue
        try {
          const lines = readFileSync(full, 'utf8').split('\n').filter(Boolean)
          let title = '', count = 0
          for (const ln of lines) { const p = parseCursorLine(ln); if (p.who) { count++; if (p.who === 'user' && !title && p.text) title = clip(p.text) } }
          const mt = statSync(full).mtimeMs
          out.push({ source: 'cursor', externalId: sess.name, cwd, title: title || '历史会话', startedAt: mt, lastTs: mt, messageCount: count, filePaths: [full], hasBody: true })
        } catch { /* skip */ }
      }
    }
    return out
  },
  readMessages(s) {
    const out: ImportedMessage[] = []
    for (const f of s.filePaths) {
      let lines; try { lines = readFileSync(f, 'utf8').split('\n').filter(Boolean) } catch { continue }
      for (const ln of lines) { const p = parseCursorLine(ln); if (p.who && p.text) out.push({ who: p.who, text: p.text, ts: '' }) }
    }
    return out
  },
}
