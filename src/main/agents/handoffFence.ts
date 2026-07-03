import type { HandoffPayload } from './types'

// A handoff body is a single small JSON object; a fence buffering far more than that is a
// stray/unclosed opener. Cap the buffer so it fails open instead of swallowing the rest of
// the stream forever (only flush() would otherwise release it, at stream end).
const MAX_FENCE_LINES = 64

export function createFenceScanner(onHandoff: (p: HandoffPayload) => void): {
  feedLine(line: string): string[]
  flush(): string[]
} {
  let inFence = false
  let openLine = ''
  let bufferedLines: string[] = []

  function feedLine(line: string): string[] {
    const trimmed = line.trim()

    if (!inFence) {
      if (trimmed === '```forge:handoff') {
        inFence = true
        openLine = line
        bufferedLines = []
        return []
      }
      return [line]
    }

    // In fence mode
    if (trimmed === '```') {
      // Close the fence
      const body = bufferedLines.join('\n')
      const capturedOpen = openLine
      const capturedBuffer = bufferedLines.slice()
      const capturedClose = line

      inFence = false
      openLine = ''
      bufferedLines = []

      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        // Bad JSON: fail-open, return all lines verbatim
        return [capturedOpen, ...capturedBuffer, capturedClose]
      }

      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        typeof (parsed as Record<string, unknown>).summary !== 'string' ||
        (parsed as Record<string, unknown>).summary === ''
      ) {
        // Invalid shape: fail-open
        return [capturedOpen, ...capturedBuffer, capturedClose]
      }

      const rec = parsed as Record<string, unknown>
      const payload: HandoffPayload = { summary: rec.summary as string }

      if (Array.isArray(rec.artifacts)) {
        const filtered = (rec.artifacts as unknown[]).filter(
          (item): item is { path: string; kind: string } =>
            item !== null &&
            typeof item === 'object' &&
            !Array.isArray(item) &&
            typeof (item as Record<string, unknown>).path === 'string' &&
            typeof (item as Record<string, unknown>).kind === 'string'
        )
        payload.artifacts = filtered
      }

      onHandoff(payload)
      return []
    }

    // Any other line in buffer mode: accumulate (bounded — fail open on a runaway fence).
    bufferedLines.push(line)
    if (bufferedLines.length > MAX_FENCE_LINES) {
      const drained = [openLine, ...bufferedLines]
      inFence = false
      openLine = ''
      bufferedLines = []
      return drained
    }
    return []
  }

  function flush(): string[] {
    if (!inFence) return []
    const result = [openLine, ...bufferedLines]
    inFence = false
    openLine = ''
    bufferedLines = []
    return result
  }

  return { feedLine, flush }
}
