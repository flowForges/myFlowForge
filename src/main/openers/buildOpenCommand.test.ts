import { describe, it, expect } from 'vitest'
import { buildOpenCommand } from './buildOpenCommand'

const APP = '/Applications/VS Code.app'
const EXE = 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'

describe('buildOpenCommand (macOS)', () => {
  const mac = (mode: any, target: any) => buildOpenCommand('darwin', mode, APP, target)

  it('no file → one `open -a <app> <folder>` for every mode', () => {
    for (const mode of ['together', 'folder-then-file', 'folder-only'] as const) {
      expect(mac(mode, { folder: '/ws' })).toEqual([{ exe: 'open', args: ['-a', APP, '/ws'] }])
    }
  })

  it('together + file → single invocation opening folder AND file', () => {
    expect(mac('together', { folder: '/ws', file: '/ws/src/a.ts' }))
      .toEqual([{ exe: 'open', args: ['-a', APP, '/ws', '/ws/src/a.ts'] }])
  })

  it('folder-then-file + file → open folder, then open file (two invocations)', () => {
    expect(mac('folder-then-file', { folder: '/ws', file: '/ws/src/a.ts' }))
      .toEqual([{ exe: 'open', args: ['-a', APP, '/ws'] }, { exe: 'open', args: ['-a', APP, '/ws/src/a.ts'] }])
  })

  it("folder-only + file → open the file's parent folder (can't target the file)", () => {
    expect(mac('folder-only', { folder: '/ws', file: '/ws/src/a.ts' }))
      .toEqual([{ exe: 'open', args: ['-a', APP, '/ws/src'] }])
  })
})

describe('buildOpenCommand (Windows)', () => {
  const win = (mode: any, target: any, argStyle?: any) => buildOpenCommand('win32', mode, EXE, target, argStyle)

  it('launches the app executable directly — there is no `open` on Windows', () => {
    expect(win('together', { folder: 'C:\\ws' })).toEqual([{ exe: EXE, args: ['C:\\ws'] }])
  })

  it('together + file → one launch with folder AND file', () => {
    expect(win('together', { folder: 'C:\\ws', file: 'C:\\ws\\src\\a.ts' }))
      .toEqual([{ exe: EXE, args: ['C:\\ws', 'C:\\ws\\src\\a.ts'] }])
  })

  it('folder-then-file + file → two launches', () => {
    expect(win('folder-then-file', { folder: 'C:\\ws', file: 'C:\\ws\\src\\a.ts' }))
      .toEqual([{ exe: EXE, args: ['C:\\ws'] }, { exe: EXE, args: ['C:\\ws\\src\\a.ts'] }])
  })

  it("folder-only + file → the file's parent folder, split with Windows separators", () => {
    expect(win('folder-only', { folder: 'C:\\ws', file: 'C:\\ws\\src\\a.ts' }))
      .toEqual([{ exe: EXE, args: ['C:\\ws\\src'] }])
  })

  it('cwd-flag apps (Windows Terminal) take the folder via -d, never as a bare argument', () => {
    const WT = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe'
    expect(buildOpenCommand('win32', 'folder-only', WT, { folder: 'C:\\ws' }, 'cwd-flag'))
      .toEqual([{ exe: WT, args: ['-d', 'C:\\ws'] }])
  })

  it('cwd-flag + file → still the containing folder via -d (a terminal cannot open a file)', () => {
    const WT = 'C:\\wt.exe'
    expect(buildOpenCommand('win32', 'folder-only', WT, { folder: 'C:\\ws', file: 'C:\\ws\\src\\a.ts' }, 'cwd-flag'))
      .toEqual([{ exe: WT, args: ['-d', 'C:\\ws\\src'] }])
  })
})
