import { describe, it, expect } from 'vitest'
import {
  parseClaudeAliasMap,
  aliasMapToModels,
  resolveRealClaudeBin,
  extractAliasMapFromFile,
  readClaudeModelsLive,
} from './claudeModels'

// A realistic minified slice of claude's compiled bundle. The alias map is an object literal
// with unquoted shorthand keys, surrounded by other `claude-*` strings that must NOT be captured.
const REAL_SNIPPET =
  'x={default:"claude-opus-4-8",legacy:"claude-opus-4-1-20250805"};' +
  'M={haiku:"claude-haiku-4-5-20251001",sonnet:"claude-sonnet-4-6",fable:"claude-fable-5",opus:"claude-opus-4-8"}' +
  ';desc="Best for everyday";other="claude-sonnet-4-5-20250929"'

describe('parseClaudeAliasMap', () => {
  it('extracts opus/sonnet/haiku/fable → real model ids from a minified bundle slice', () => {
    expect(parseClaudeAliasMap(REAL_SNIPPET)).toEqual({
      opus: 'claude-opus-4-8',
      sonnet: 'claude-sonnet-4-6',
      haiku: 'claude-haiku-4-5-20251001',
      fable: 'claude-fable-5',
    })
  })

  it('accepts quoted keys too ("opus":"claude-...")', () => {
    const s = '{"opus":"claude-opus-4-8","sonnet":"claude-sonnet-4-6"}'
    expect(parseClaudeAliasMap(s)).toEqual({ opus: 'claude-opus-4-8', sonnet: 'claude-sonnet-4-6' })
  })

  it('keeps the FIRST id when an alias appears more than once', () => {
    const s = 'opus:"claude-opus-4-8" ... later opus:"claude-opus-4-1-20250805"'
    expect(parseClaudeAliasMap(s).opus).toBe('claude-opus-4-8')
  })

  it('ignores bare claude-* ids not in the alias:"id" form', () => {
    expect(parseClaudeAliasMap('models=["claude-opus-4-8","claude-sonnet-4-6"]')).toEqual({})
  })

  it('fails open to {} on empty/garbage content', () => {
    expect(parseClaudeAliasMap('')).toEqual({})
    expect(parseClaudeAliasMap('no models here')).toEqual({})
  })
})

describe('aliasMapToModels', () => {
  it('maps to Model[] keyed on the real id, ordered opus/sonnet/haiku/fable', () => {
    const out = aliasMapToModels({
      sonnet: 'claude-sonnet-4-6',
      opus: 'claude-opus-4-8',
      haiku: 'claude-haiku-4-5-20251001',
      fable: 'claude-fable-5',
    })
    expect(out).toEqual([
      { id: 'claude-opus-4-8', label: 'Opus', description: 'opus → claude-opus-4-8' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet', description: 'sonnet → claude-sonnet-4-6' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku', description: 'haiku → claude-haiku-4-5-20251001' },
      { id: 'claude-fable-5', label: 'Fable', description: 'fable → claude-fable-5' },
    ])
  })

  it('omits aliases absent from the map', () => {
    expect(aliasMapToModels({ opus: 'claude-opus-4-8' })).toEqual([
      { id: 'claude-opus-4-8', label: 'Opus', description: 'opus → claude-opus-4-8' },
    ])
  })

  it('returns [] for an empty map', () => {
    expect(aliasMapToModels({})).toEqual([])
  })
})

describe('resolveRealClaudeBin', () => {
  const BIG = 200_000_000
  it('follows the launcher symlink to the real (large) binary', () => {
    const real = resolveRealClaudeBin('/h/.local/bin/claude', {
      realpath: p => (p === '/h/.local/bin/claude' ? '/h/.local/share/claude/versions/2.1.186' : p),
      statSize: () => BIG,
      existsSync: () => true,
      home: '/h',
    })
    expect(real).toBe('/h/.local/share/claude/versions/2.1.186')
  })

  it('rejects a tiny shim and falls back to a known candidate path', () => {
    const real = resolveRealClaudeBin('/usr/bin/claude-shim', {
      realpath: p => p,
      // launcher resolves to a tiny wrapper; the homebrew candidate is the real bundle
      statSize: p => (p === '/opt/homebrew/bin/claude' ? BIG : 500),
      existsSync: p => p === '/usr/bin/claude-shim' || p === '/opt/homebrew/bin/claude',
      home: '/h',
    })
    expect(real).toBe('/opt/homebrew/bin/claude')
  })

  it('returns "" when no candidate is a real bundle', () => {
    expect(resolveRealClaudeBin('/usr/bin/claude', {
      realpath: p => p,
      statSize: () => 500,
      existsSync: () => true,
      home: '/h',
    })).toBe('')
  })
})

describe('extractAliasMapFromFile', () => {
  it('captures a match that spans a chunk boundary', () => {
    // Split right in the middle of `claude-opus-4-8`
    const chunks = ['junk opus:"claude-op', 'us-4-8" more sonnet:"claude-sonnet-4-6" tail']
    const map = extractAliasMapFromFile('/x', { readChunks: () => chunks })
    expect(map).toEqual({ opus: 'claude-opus-4-8', sonnet: 'claude-sonnet-4-6' })
  })

  it('fails open to {} when the reader throws', () => {
    expect(extractAliasMapFromFile('/x', { readChunks: () => { throw new Error('EACCES') } })).toEqual({})
  })

  it('stops reading once all four aliases are found (no need to scan the rest of a huge binary)', () => {
    // First chunk already has all 4; a second chunk would throw — early-exit must avoid reading it.
    function* chunks() {
      yield 'm={opus:"claude-opus-4-8",sonnet:"claude-sonnet-4-6",' +
        'haiku:"claude-haiku-4-5-20251001",fable:"claude-fable-5"}'
      throw new Error('should not read past the complete map')
    }
    expect(extractAliasMapFromFile('/x', { readChunks: chunks })).toEqual({
      opus: 'claude-opus-4-8',
      sonnet: 'claude-sonnet-4-6',
      haiku: 'claude-haiku-4-5-20251001',
      fable: 'claude-fable-5',
    })
  })
})

describe('readClaudeModelsLive', () => {
  const deps = {
    which: async () => '/h/.local/bin/claude',
    realpath: (p: string) => (p === '/h/.local/bin/claude' ? '/h/.local/share/claude/versions/2.1.186' : p),
    statSize: () => 200_000_000,
    existsSync: () => true,
    readChunks: () => ['m={opus:"claude-opus-4-8",sonnet:"claude-sonnet-4-6"}'],
    home: '/h',
  }

  it('resolves the binary and returns live Model[] from the embedded alias map', async () => {
    const out = await readClaudeModelsLive('claude', {}, deps)
    expect(out).toEqual([
      { id: 'claude-opus-4-8', label: 'Opus', description: 'opus → claude-opus-4-8' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet', description: 'sonnet → claude-sonnet-4-6' },
    ])
  })

  it('fails open to [] when the binary cannot be resolved', async () => {
    const out = await readClaudeModelsLive('claude', {}, {
      ...deps,
      which: async () => '',
      existsSync: () => false,
    })
    expect(out).toEqual([])
  })
})
