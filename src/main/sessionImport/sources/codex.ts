import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DiscoveredSession, ImportedMessage } from '@shared/types'
import type { SessionSource } from './claude'

interface Parsed { kind: 'meta' | 'msg' | 'none'; id?: string; cwd?: string; ts?: number; who?: 'user' | 'ai'; text?: string }
function blockText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.filter((b: any) => typeof b?.text === 'string').map((b: any) => b.text).join('\n')
}
export function parseCodexLine(line: string): Parsed {
  let o: any
  try { o = JSON.parse(line) } catch { return { kind: 'none' } }
  const ts = o.timestamp ? Date.parse(o.timestamp) : undefined
  if (o.type === 'session_meta') return { kind: 'meta', id: o.payload?.id, cwd: o.payload?.cwd, ts: o.payload?.timestamp ? Date.parse(o.payload.timestamp) : ts }
  if (o.type === 'response_item' && o.payload?.type === 'message') {
    const role = o.payload.role
    if (role === 'user') return { kind: 'msg', who: 'user', text: blockText(o.payload.content), ts }
    if (role === 'assistant') return { kind: 'msg', who: 'ai', text: blockText(o.payload.content), ts }
  }
  return { kind: 'none' }
}
function clip(t: string): string { const s = t.replace(/\s+/g, ' ').trim(); return s.length > 40 ? s.slice(0, 40) + '…' : (s || '历史会话') }

function walkJsonl(dir: string, out: string[] = []): string[] {
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walkJsonl(p, out)
    else if (e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

export const codexSource: SessionSource = {
  id: 'codex',
  scan(roots) {
    const out: DiscoveredSession[] = []
    if (!roots.codex || !existsSync(roots.codex)) return out
    for (const full of walkJsonl(roots.codex)) {
      try {
        const lines = readFileSync(full, 'utf8').split('\n').filter(Boolean)
        let id = '', cwd = '', title = '', count = 0, startedAt = 0, lastTs = 0
        for (const ln of lines) {
          const p = parseCodexLine(ln)
          if (p.kind === 'meta') { if (p.id) id = p.id; if (p.cwd) cwd = p.cwd; if (p.ts) startedAt = p.ts }
          if (p.ts) lastTs = p.ts
          if (p.kind === 'msg' && p.who) { count++; if (p.who === 'user' && !title && p.text) title = clip(p.text) }
        }
        if (!id) id = full.split('/').pop()!.replace(/\.jsonl$/, '')
        if (!startedAt) startedAt = statSync(full).mtimeMs
        out.push({ source: 'codex', externalId: id, cwd: cwd || 'unknown', title: title || '历史会话', startedAt, lastTs: lastTs || startedAt, messageCount: count, filePaths: [full], hasBody: true })
      } catch { /* skip */ }
    }
    return out
  },
  readMessages(s) {
    const out: ImportedMessage[] = []
    for (const f of s.filePaths) {
      let lines; try { lines = readFileSync(f, 'utf8').split('\n').filter(Boolean) } catch { continue }
      for (const ln of lines) { const p = parseCodexLine(ln); if (p.kind === 'msg' && p.who && p.text) out.push({ who: p.who, text: p.text, ts: p.ts ? new Date(p.ts).toISOString() : '' }) }
    }
    return out
  },
}
