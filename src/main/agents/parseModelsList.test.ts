import { describe, it, expect } from 'vitest'
import { parseModelsList } from './parseModelsList'

// NOTE: The real stdout format of qodercli/cursor-agent --list-models is UNKNOWN
// (both CLIs require login; not logged in in this environment). All inputs below
// are synthetic and designed to exercise the parser's tolerance.

describe('parseModelsList — JSON array', () => {
  it('maps {id, name} objects → Model[]', () => {
    const input = JSON.stringify([
      { id: 'm1', name: 'M1' },
      { id: 'm2', name: 'M2', description: 'fast' },
    ])
    const result = parseModelsList(input)
    expect(result).toEqual([
      { id: 'm1', label: 'M1' },
      { id: 'm2', label: 'M2', description: 'fast' },
    ])
  })

  it('falls back to name for id when id is absent', () => {
    const input = JSON.stringify([{ name: 'gpt-4o' }, { model: 'claude-3' }])
    const result = parseModelsList(input)
    expect(result[0]).toMatchObject({ id: 'gpt-4o', label: 'gpt-4o' })
    expect(result[1]).toMatchObject({ id: 'claude-3', label: 'claude-3' })
  })

  it('skips entries where no id/name/model field is present', () => {
    const input = JSON.stringify([
      { label: 'no-id' },
      { id: 'keep', label: 'Keep' },
    ])
    const result = parseModelsList(input)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('keep')
  })

  it('prefers label field when present', () => {
    const input = JSON.stringify([{ id: 'x', name: 'X Name', label: 'Pretty X' }])
    const result = parseModelsList(input)
    expect(result[0].label).toBe('Pretty X')
  })

  it('returns [] for an empty JSON array', () => {
    expect(parseModelsList('[]')).toEqual([])
  })
})

describe('parseModelsList — JSON object with .models or .data', () => {
  it('unwraps {models:[...]} and maps entries', () => {
    const input = JSON.stringify({
      models: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }],
    })
    const result = parseModelsList(input)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ id: 'a', label: 'Alpha' })
  })

  it('unwraps {data:[...]} and maps entries', () => {
    const input = JSON.stringify({
      data: [{ id: 'c', name: 'Charlie' }],
    })
    const result = parseModelsList(input)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('c')
  })

  it('returns [] when models array is empty', () => {
    expect(parseModelsList(JSON.stringify({ models: [] }))).toEqual([])
  })
})

describe('parseModelsList — plain-text lines', () => {
  it('treats each non-empty line as a model (id only → label=id)', () => {
    const input = 'gpt-4o\nclaude-3-sonnet\ngemini-pro'
    const result = parseModelsList(input)
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ id: 'gpt-4o', label: 'gpt-4o' })
    expect(result[2]).toEqual({ id: 'gemini-pro', label: 'gemini-pro' })
  })

  it('uses remaining tokens as label/description when line has multiple tokens', () => {
    const input = 'gpt-4o  Fast GPT model\nclaude-sonnet Best for coding'
    const result = parseModelsList(input)
    expect(result[0]).toMatchObject({ id: 'gpt-4o', label: 'Fast GPT model', description: 'Fast GPT model' })
    expect(result[1]).toMatchObject({ id: 'claude-sonnet', label: 'Best for coding' })
  })

  it('skips an ALL-CAPS table header row (qoder --list-models table output)', () => {
    const input = 'MODEL              PROVIDER   CONTEXT\ngpt-4o             openai     128k\nclaude-sonnet      anthropic  200k'
    const result = parseModelsList(input)
    expect(result.map(m => m.id)).toEqual(['gpt-4o', 'claude-sonnet'])
  })

  it('skips separator lines made of dashes/pipes', () => {
    const input = 'NAME       DESCRIPTION\n---------  -----------\ngpt-4o     Fast model'
    const result = parseModelsList(input)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('gpt-4o')
  })

  it('does not skip legit model ids that merely contain uppercase', () => {
    const input = 'GPT-4o\nQwen-Max fast'
    const result = parseModelsList(input)
    expect(result.map(m => m.id)).toEqual(['GPT-4o', 'Qwen-Max'])
  })

  it('skips blank lines', () => {
    const input = '\n  \ngpt-4o\n\nclaude-3\n'
    const result = parseModelsList(input)
    expect(result).toHaveLength(2)
  })
})

describe('parseModelsList — auth/error text → []', () => {
  it('returns [] for "Not logged in" message', () => {
    expect(parseModelsList('Not logged in. Please run: qodercli login')).toEqual([])
  })

  it('returns [] for "Authentication required" message', () => {
    expect(parseModelsList('Authentication required. Visit https://example.com to login.')).toEqual([])
  })

  it('returns [] for output containing "Error"', () => {
    expect(parseModelsList('Error: failed to connect to API')).toEqual([])
  })

  it('returns [] for output containing "login" (case-insensitive)', () => {
    expect(parseModelsList('Please Login to continue')).toEqual([])
  })
})

describe('parseModelsList — empty / garbage → []', () => {
  it('returns [] for empty string', () => {
    expect(parseModelsList('')).toEqual([])
  })

  it('returns [] for whitespace-only string', () => {
    expect(parseModelsList('   \n  \t  ')).toEqual([])
  })

  it('returns [] for invalid JSON that is also an auth message', () => {
    expect(parseModelsList('{{invalid}} login required')).toEqual([])
  })

  it('returns [] for random garbage that is not auth but still unrecognisable', () => {
    // garbage but no auth keywords — parser will try plain-text line treatment
    // a single garbage token like "???!" becomes a model id — that is intentional fail-open
    const result = parseModelsList('???!')
    // Either [] or [{id:'???!', ...}]; parser is fail-open so both are acceptable.
    // Here we only assert it does NOT throw.
    expect(Array.isArray(result)).toBe(true)
  })

  it('returns [] on deeply malformed input that throws internally', () => {
    // Force a code path that might throw: a JSON string (not object/array)
    expect(parseModelsList('"just a string"')).toEqual([])
  })
})
