import type { Model } from './types'

/** Auth/error keywords that indicate the whole output is a login prompt, not a model list. */
const AUTH_PATTERNS = /login|authentication|not logged in|error/i

/** Column headings seen in tabular CLI output (e.g. qoder `--list-models` prints a MODEL/PROVIDER table). */
const HEADER_WORDS = new Set(['MODEL', 'MODELS', 'NAME', 'ID', 'PROVIDER', 'DESCRIPTION', 'CONTEXT', 'ALIAS', 'AVAILABLE', 'STATUS', 'TYPE'])

/** A table header row: every token is an ALL-CAPS word and at least one is a known column heading. */
function isHeaderRow(tokens: string[]): boolean {
  return tokens.every(t => /^[A-Z][A-Z0-9_-]*$/.test(t)) && tokens.some(t => HEADER_WORDS.has(t))
}

/** A table separator row: only dashes/pipes/box-drawing characters. */
function isSeparatorRow(line: string): boolean {
  return /^[-=+|─═┼┬┴┌┐└┘├┤\s]+$/.test(line)
}

/**
 * Parse the stdout of a `--list-models` CLI invocation into a list of Models.
 * Always fail-open: any exception or unrecognised format returns [].
 * Real stdout format for qoder/cursor is UNKNOWN (not logged in), so every
 * branch is intentionally tolerant.
 */
export function parseModelsList(stdout: string): Model[] {
  try {
    const trimmed = stdout.trim()
    if (!trimmed) return []

    // --- Try JSON first ---
    let parsed: unknown
    try { parsed = JSON.parse(trimmed) } catch { parsed = undefined }

    if (parsed !== undefined) {
      // JSON array of objects
      if (Array.isArray(parsed)) return mapObjects(parsed)

      // JSON object with a .models or .data array
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>
        if (Array.isArray(obj['models'])) return mapObjects(obj['models'] as unknown[])
        if (Array.isArray(obj['data'])) return mapObjects(obj['data'] as unknown[])
        // JSON object but no recognised shape → no models
        return []
      }

      // JSON primitive (string, number, boolean, null) — unrecognised, no models
      return []
    }

    // --- Plain-text lines ---
    // If the WHOLE output looks like an auth/error message, bail out
    if (AUTH_PATTERNS.test(trimmed)) return []

    const models: Model[] = []
    for (const rawLine of trimmed.split('\n')) {
      const line = rawLine.trim()
      if (!line || isSeparatorRow(line)) continue
      const tokens = line.split(/\s+/)
      const id = tokens[0]
      if (!id) continue
      if (isHeaderRow(tokens)) continue
      const rest = tokens.slice(1).join(' ')
      models.push({ id, label: rest || id, ...(rest ? { description: rest } : {}) })
    }
    return models
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function mapObjects(arr: unknown[]): Model[] {
  const models: Model[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const id = strOf(o['id']) ?? strOf(o['name']) ?? strOf(o['model'])
    if (!id) continue   // skip entries with no resolvable id
    const label = strOf(o['label']) ?? strOf(o['name']) ?? id
    const description = strOf(o['description'])
    models.push({ id, label, ...(description ? { description } : {}) })
  }
  return models
}

function strOf(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}
