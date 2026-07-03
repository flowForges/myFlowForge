// Assemble the design-stage review body shown at the inter-stage hard gate. Pulls each design
// agent's handoff summary (the technical plan it produced) so the gate confirm card shows the
// actual plan to review — not just an approve/reject button. When an agent produced NO handoff
// fence (e.g. codex answered without emitting one), fall back to its real answer output so the plan
// is still shown instead of an empty gate.

import type { LogLine } from '@shared/types'

export interface GateAgent { id: string; name: string }

// The agent's actual answer text = its `output`-kind log lines (assistant result/deltas), joined.
// think/tool/file lines are process noise, not the plan, so they're excluded.
export function outputFromLogs(logs: LogLine[] | undefined): string {
  if (!logs) return ''
  return logs
    .filter(l => l.kind === 'output' && l.text.trim().length > 0)
    .map(l => l.text.trim())
    .join('\n')
    .trim()
}

// A design doc an agent wrote to disk and reported via forge_handoff artifacts: a path relative
// to the agent's cwd (its project worktree, or the workspace root for the summary agent).
export interface DesignDoc { path: string; cwd: string; name: string }

// Choose the markdown design doc among an agent's reported artifacts: prefer a `.md` path, else an
// artifact whose kind is md/markdown/doc. Non-doc artifacts (code, etc.) are ignored.
export function pickDocArtifact(artifacts: { path: string; kind: string }[] | undefined): string | undefined {
  if (!artifacts?.length) return undefined
  const byExt = artifacts.find(a => /\.md$/i.test(a.path.trim()))
  if (byExt) return byExt.path.trim()
  const byKind = artifacts.find(a => /^(md|markdown|doc)$/i.test((a.kind ?? '').trim()))
  return byKind ? byKind.path.trim() : undefined
}

// Collect the design docs reported by the stage's agents (in agent order — the summary agent is
// appended last, so it lands last). Agents without a reported doc or a known cwd are skipped.
export function buildDesignDocs(
  agents: GateAgent[],
  getDocPath: (agentId: string) => string | undefined,
  cwdOf: (agentId: string) => string | undefined,
): DesignDoc[] {
  const out: DesignDoc[] = []
  for (const a of agents) {
    const path = getDocPath(a.id)?.trim()
    const cwd = cwdOf(a.id)
    if (path && cwd) out.push({ path, cwd, name: a.name })
  }
  return out
}

// The gate card renders the consolidated design doc's full content when one exists (read from disk);
// otherwise it falls back to the assembled handoff-summary body (buildGateBody).
export function gateBodyFromDoc(
  primary: DesignDoc | undefined,
  readDoc: (doc: DesignDoc) => string | undefined,
  fallback: () => string | undefined,
): string | undefined {
  if (primary) {
    const content = readDoc(primary)?.trim()
    if (content) return content
  }
  return fallback()
}

export function buildGateBody(
  agents: GateAgent[],
  getHandoff: (agentId: string) => unknown,
  getOutput?: (agentId: string) => string | undefined,
): string | undefined {
  const notes = agents
    .map(a => {
      const h = getHandoff(a.id)
      const handoff = typeof h === 'string' ? h.trim() : ''
      const summary = handoff.length > 0 ? handoff : (getOutput?.(a.id) ?? '').trim()
      return { name: a.name, summary }
    })
    .filter(x => x.summary.length > 0)
  if (notes.length === 0) return undefined
  if (notes.length === 1) return notes[0].summary
  return notes.map(x => `### ${x.name}\n\n${x.summary}`).join('\n\n')
}
