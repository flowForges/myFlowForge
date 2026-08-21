import { describe, it, expect } from 'vitest'
import { resolveWindowsPath, type WinFsProbe } from './winPaths'

const ENV = {
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  SystemRoot: 'C:\\Windows',
}

// A fake Windows filesystem: a flat set of full paths, plus the directories implied by them.
function fakeFs(paths: string[]): WinFsProbe {
  const set = new Set(paths.map(p => p.toLowerCase()))
  const dirs = new Map<string, Set<string>>()
  for (const p of paths) {
    const parts = p.split('\\')
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('\\').toLowerCase()
      if (!dirs.has(parent)) dirs.set(parent, new Set())
      dirs.get(parent)!.add(parts[i])
      set.add(parts.slice(0, i + 1).join('\\').toLowerCase())
    }
  }
  return {
    exists: p => set.has(p.toLowerCase()),
    readdir: d => [...(dirs.get(d.toLowerCase()) ?? [])],
  }
}

describe('resolveWindowsPath — %VAR% expansion', () => {
  it('expands a known variable and returns the path when it exists', () => {
    const fs = fakeFs(['C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'])
    expect(resolveWindowsPath('%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe', ENV, fs))
      .toBe('C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe')
  })

  it('returns null when the expanded path is not on disk', () => {
    expect(resolveWindowsPath('%LOCALAPPDATA%\\Nope\\Nope.exe', ENV, fakeFs([]))).toBeNull()
  })

  // An undefined variable must fail the candidate OUTRIGHT. Substituting it with '' would leave a
  // drive-relative path (`\Windows\explorer.exe`), which Windows happily resolves against the current
  // drive — i.e. we'd silently probe, and possibly launch, an entirely different file.
  it('fails the candidate when a variable is undefined, even if the collapsed path would exist', () => {
    const always: WinFsProbe = { exists: () => true, readdir: () => [] }
    expect(resolveWindowsPath('%NOPE%\\Windows\\explorer.exe', {}, always)).toBeNull()
  })

  it('matches variable names case-insensitively, like the real Windows environment', () => {
    const fs = fakeFs(['C:\\Program Files (x86)\\Sublime Text\\sublime_text.exe'])
    expect(resolveWindowsPath('%PROGRAMFILES(X86)%\\Sublime Text\\sublime_text.exe', ENV, fs))
      .toBe('C:\\Program Files (x86)\\Sublime Text\\sublime_text.exe')
  })
})

describe('resolveWindowsPath — * wildcards (versioned install dirs)', () => {
  it('resolves a trailing-wildcard segment against the real directory listing', () => {
    const fs = fakeFs(['C:\\Program Files\\JetBrains\\IntelliJ IDEA 2024.1\\bin\\idea64.exe'])
    expect(resolveWindowsPath('%ProgramFiles%\\JetBrains\\IntelliJ IDEA*\\bin\\idea64.exe', ENV, fs))
      .toBe('C:\\Program Files\\JetBrains\\IntelliJ IDEA 2024.1\\bin\\idea64.exe')
  })

  it('picks the newest when several versions are installed (descending order)', () => {
    const fs = fakeFs([
      'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2023.3\\bin\\idea64.exe',
      'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2024.2\\bin\\idea64.exe',
      'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2024.1\\bin\\idea64.exe',
    ])
    expect(resolveWindowsPath('%ProgramFiles%\\JetBrains\\IntelliJ IDEA*\\bin\\idea64.exe', ENV, fs))
      .toBe('C:\\Program Files\\JetBrains\\IntelliJ IDEA 2024.2\\bin\\idea64.exe')
  })

  it('backtracks: a newer directory that lacks the executable does not shadow an older one that has it', () => {
    const fs = fakeFs([
      'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2024.2\\bin\\other.txt',
      'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2023.3\\bin\\idea64.exe',
    ])
    expect(resolveWindowsPath('%ProgramFiles%\\JetBrains\\IntelliJ IDEA*\\bin\\idea64.exe', ENV, fs))
      .toBe('C:\\Program Files\\JetBrains\\IntelliJ IDEA 2023.3\\bin\\idea64.exe')
  })

  it('handles several wildcard segments (JetBrains Toolbox channel/build layout)', () => {
    const fs = fakeFs(['C:\\Users\\me\\AppData\\Local\\JetBrains\\Toolbox\\apps\\IDEA-U\\ch-0\\241.14494.240\\bin\\idea64.exe'])
    expect(resolveWindowsPath('%LOCALAPPDATA%\\JetBrains\\Toolbox\\apps\\IDEA-U\\*\\*\\bin\\idea64.exe', ENV, fs))
      .toBe('C:\\Users\\me\\AppData\\Local\\JetBrains\\Toolbox\\apps\\IDEA-U\\ch-0\\241.14494.240\\bin\\idea64.exe')
  })

  it('a wildcard that matches nothing yields null, not a partial path', () => {
    const fs = fakeFs(['C:\\Program Files\\JetBrains\\readme.txt'])
    expect(resolveWindowsPath('%ProgramFiles%\\JetBrains\\PyCharm*\\bin\\pycharm64.exe', ENV, fs)).toBeNull()
  })

  it('an unreadable directory yields null instead of throwing', () => {
    const probe: WinFsProbe = { exists: () => false, readdir: () => { throw new Error('EACCES') } }
    expect(resolveWindowsPath('%ProgramFiles%\\JetBrains\\*\\bin\\idea64.exe', ENV, probe)).toBeNull()
  })

  it('a wildcard consumes exactly one directory level, never a deeper subtree', () => {
    const fs = fakeFs(['C:\\Program Files\\JetBrains\\IDEA\\bin\\idea64.exe'])
    // `JetBrains*\bin\…` must not reach through the extra `IDEA` level below JetBrains.
    expect(resolveWindowsPath('%ProgramFiles%\\JetBrains*\\bin\\idea64.exe', ENV, fs)).toBeNull()
    // …and one wildcard for that level does find it.
    expect(resolveWindowsPath('%ProgramFiles%\\JetBrains\\*\\bin\\idea64.exe', ENV, fs))
      .toBe('C:\\Program Files\\JetBrains\\IDEA\\bin\\idea64.exe')
  })
})

describe('resolveWindowsPath — first hit wins across a candidate list', () => {
  it('resolveFirstWindowsPath returns the first template that resolves', async () => {
    const { resolveFirstWindowsPath } = await import('./winPaths')
    const fs = fakeFs(['C:\\Program Files\\Microsoft VS Code\\Code.exe'])
    expect(resolveFirstWindowsPath([
      '%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe',
      '%ProgramFiles%\\Microsoft VS Code\\Code.exe',
    ], ENV, fs)).toBe('C:\\Program Files\\Microsoft VS Code\\Code.exe')
  })

  it('resolveFirstWindowsPath returns null when no template resolves', async () => {
    const { resolveFirstWindowsPath } = await import('./winPaths')
    expect(resolveFirstWindowsPath(['%ProgramFiles%\\a\\b.exe'], ENV, fakeFs([]))).toBeNull()
  })
})
