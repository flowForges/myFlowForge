// A forge:run body is a single small JSON object; cap the buffer so an unclosed fence fails open
// (drains verbatim) instead of swallowing the rest of the stream. fail-SAFE: a run is only
// triggered on a cleanly-closed fence whose JSON has a non-empty string `task`; anything else is
// returned verbatim and triggers nothing (we must never start a run by accident).
const MAX_FENCE_LINES = 64

export function createRunFenceScanner(onRun: (task: string) => void): {
  feedLine(line: string): string[]
  flush(): string[]
} {
  let inFence = false
  let openLine = ''
  let bufferedLines: string[] = []

  function feedLine(line: string): string[] {
    const trimmed = line.trim()

    if (!inFence) {
      if (trimmed === '```forge:run') {
        inFence = true
        openLine = line
        bufferedLines = []
        return []
      }
      return [line]
    }

    if (trimmed === '```') {
      const body = bufferedLines.join('\n')
      const verbatim = [openLine, ...bufferedLines, line]
      inFence = false
      openLine = ''
      bufferedLines = []

      let parsed: unknown
      try { parsed = JSON.parse(body) } catch { return verbatim }

      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        typeof (parsed as Record<string, unknown>).task !== 'string' ||
        (parsed as Record<string, unknown>).task === ''
      ) {
        return verbatim
      }

      onRun((parsed as Record<string, unknown>).task as string)
      return []
    }

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
