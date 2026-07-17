import { z } from 'zod'
import type { HandoffPayload } from '../agents/types'

export const HandoffResultSchema = z.object({
  project: z.string().optional(),
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  testsRun: z.object({ passed: z.boolean(), detail: z.string().optional() }).optional(),
  blockers: z.array(z.string()).default([]),
  doubts: z.array(z.string()).default([]),
  artifacts: z.array(z.object({ path: z.string(), kind: z.string() })).default([]),
})
export type HandoffResult = z.infer<typeof HandoffResultSchema>

const BLOCK_RE = /```forge-result\s*\n([\s\S]*?)\n```/

export function parseHandoffResult(payload: HandoffPayload): HandoffResult {
  const fallback: HandoffResult = {
    summary: payload.summary,
    filesChanged: [],
    blockers: [],
    doubts: [],
    artifacts: payload.artifacts ?? [],
  }
  const m = BLOCK_RE.exec(payload.summary || '')
  if (!m) return fallback
  try {
    const parsed = HandoffResultSchema.parse(JSON.parse(m[1]))
    // 结构化块里没给 artifacts 时，保留 provider 侧 artifacts
    if (parsed.artifacts.length === 0 && payload.artifacts?.length) parsed.artifacts = payload.artifacts
    return parsed
  } catch {
    return fallback
  }
}
