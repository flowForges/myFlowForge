import { describe, it, expect } from 'vitest'
import { buildOpenCommand } from './buildOpenCommand'

const APP = '/Applications/VS Code.app'

describe('buildOpenCommand', () => {
  it('no file → one `open -a <app> <folder>` for every mode', () => {
    for (const mode of ['together', 'folder-then-file', 'folder-only'] as const) {
      expect(buildOpenCommand(mode, APP, { folder: '/ws' })).toEqual([['-a', APP, '/ws']])
    }
  })

  it('together + file → single invocation opening folder AND file', () => {
    expect(buildOpenCommand('together', APP, { folder: '/ws', file: '/ws/src/a.ts' }))
      .toEqual([['-a', APP, '/ws', '/ws/src/a.ts']])
  })

  it('folder-then-file + file → open folder, then open file (two invocations)', () => {
    expect(buildOpenCommand('folder-then-file', APP, { folder: '/ws', file: '/ws/src/a.ts' }))
      .toEqual([['-a', APP, '/ws'], ['-a', APP, '/ws/src/a.ts']])
  })

  it('folder-only + file → open the file\'s parent folder (can\'t target the file)', () => {
    expect(buildOpenCommand('folder-only', APP, { folder: '/ws', file: '/ws/src/a.ts' }))
      .toEqual([['-a', APP, '/ws/src']])
  })
})
