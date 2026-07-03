import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DiscoveredSession, ImportedMessage } from '@shared/types'
import type { SourceRoots } from '../types'
import { decodeDirCwd } from '../types'

export interface SessionSource {
  id: DiscoveredSession['source']
  scan(roots: SourceRoots): DiscoveredSession[]
  readMessages(s: DiscoveredSession): ImportedMessage[]
}

const TAG_NOISE = /^<(local-command|command-name|command-message)/

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
  return ''
}

interface Parsed { who?: 'user' | 'ai'; text?: string; cwd?: string; ts?: number }
export function parseClaudeLine(line: string): Parsed {
  let o: any
  try { o = JSON.parse(line) } catch { return {} }
  const ts = o.timestamp ? Date.parse(o.timestamp) : undefined
  const cwd = typeof o.cwd === 'string' ? o.cwd : undefined
  if (o.isMeta) return { cwd, ts }
  if (o.type === 'user') { const t = textOf(o.message?.content); return TAG_NOISE.test(t.trim()) ? { cwd, ts } : { who: 'user', text: t, cwd, ts } }
  if (o.type === 'assistant') { const t = textOf(o.message?.content); return { who: 'ai', text: t, cwd, ts } }
  return { cwd, ts }
}

function clipTitle(t: string): string { const s = t.replace(/\s+/g, ' ').trim(); return s.length > 40 ? s.slice(0, 40) + '…' : (s || '历史会话') }

export const claudeSource: SessionSource = {
  id: 'claude',
  scan(roots) {
    const out: DiscoveredSession[] = []
    if (!roots.claude || !existsSync(roots.claude)) return out
    for (const dir of readdirSync(roots.claude, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const projDir = join(roots.claude, dir.name)
      let files: string[]; try { files = readdirSync(projDir).filter(f => f.endsWith('.jsonl')) } catch { continue }
      for (const file of files) {
        try {
          const full = join(projDir, file)
          const lines = readFileSync(full, 'utf8').split('\n').filter(Boolean)
          let cwd = decodeDirCwd(dir.name), title = '', count = 0, startedAt = 0, lastTs = 0
          for (const ln of lines) {
            const p = parseClaudeLine(ln)
            if (p.cwd) cwd = p.cwd
            if (p.ts) { if (!startedAt) startedAt = p.ts; lastTs = p.ts }
            if (p.who) { count++; if (p.who === 'user' && !title && p.text) title = clipTitle(p.text) }
          }
          out.push({ source: 'claude', externalId: file.replace(/\.jsonl$/, ''), cwd, title: title || '历史会话', startedAt, lastTs, messageCount: count, filePaths: [full], hasBody: true })
        } catch { /* skip bad file */ }
      }
    }
    return out
  },
  readMessages(s) {
    const out: ImportedMessage[] = []
    for (const f of s.filePaths) {
      let lines: string[]; try { lines = readFileSync(f, 'utf8').split('\n').filter(Boolean) } catch { continue }
      for (const ln of lines) {
        const p = parseClaudeLine(ln)
        if (p.who && p.text) out.push({ who: p.who, text: p.text, ts: p.ts ? new Date(p.ts).toISOString() : '' })
      }
    }
    return out
  },
}
