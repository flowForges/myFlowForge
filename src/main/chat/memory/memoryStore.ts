import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { wsForgeDir, sysFile } from '../../config/paths'

export function workspaceMemoryFile(wsPath: string): string {
  return join(wsForgeDir(wsPath), 'memory', 'workspace.md')
}

export function systemMemoryFile(): string {
  return sysFile(join('memory', 'system.md'))
}

function ensureParent(file: string) {
  const d = dirname(file)
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
}

function readFile(file: string): string {
  if (!existsSync(file)) return ''
  try { return readFileSync(file, 'utf8') } catch { return '' }
}

function writeFile(file: string, content: string) {
  ensureParent(file)
  writeFileSync(file, content)
}

export function readWorkspaceMemory(wsPath: string): string { return readFile(workspaceMemoryFile(wsPath)) }
export function writeWorkspaceMemory(wsPath: string, content: string): void { writeFile(workspaceMemoryFile(wsPath), content) }
export function readSystemMemory(): string { return readFile(systemMemoryFile()) }
export function writeSystemMemory(content: string): void { writeFile(systemMemoryFile(), content) }

// Split markdown into [{ heading, body }] sections keyed by a leading `## ` line.
// Text before the first heading is captured under a synthetic '' heading (preamble).
interface Section { heading: string; text: string }
function splitSections(md: string): Section[] {
  const lines = md.split('\n')
  const out: Section[] = []
  let cur: Section = { heading: '', text: '' }
  const push = () => { if (cur.text.trim() || cur.heading) out.push({ heading: cur.heading, text: cur.text.replace(/\n+$/, '') }) }
  for (const line of lines) {
    const m = /^## (.+)$/.exec(line)
    if (m) { push(); cur = { heading: m[1].trim(), text: line + '\n' } }
    else cur.text += line + '\n'
  }
  push()
  return out
}

// Dedup-merge two memory docs by `## heading`: incoming sections REPLACE same-heading existing
// sections (update, not append); brand-new headings append after existing ones; existing-only
// headings are preserved. Blank input on either side returns the other unchanged.
export function mergeMemory(existing: string, incoming: string): string {
  if (!incoming.trim()) return existing
  if (!existing.trim()) return incoming
  const ex = splitSections(existing)
  const inc = splitSections(incoming)
  const incByHeading = new Map(inc.filter(s => s.heading).map(s => [s.heading, s]))
  const usedIncoming = new Set<string>()
  const merged: Section[] = ex.map(s => {
    if (s.heading && incByHeading.has(s.heading)) { usedIncoming.add(s.heading); return incByHeading.get(s.heading)! }
    return s
  })
  for (const s of inc) {
    if (s.heading && !usedIncoming.has(s.heading) && !ex.some(e => e.heading === s.heading)) merged.push(s)
  }
  return merged.map(s => s.text).join('\n\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
