import { parseLsofCwd, abbreviateHome } from './cwdTrack'

// Debounce-free probe: caller debounces. Tracks last reported cwd so we only emit on change.
export function makeCwdProbe(deps: { exec: (pid: number) => Promise<string>; home: string; onCwd: (cwd: string) => void }) {
  let last = ''
  return async (pid: number): Promise<void> => {
    let out = ''
    try { out = await deps.exec(pid) } catch { return }
    const raw = parseLsofCwd(out)
    if (!raw) return
    const abbr = abbreviateHome(raw, deps.home)
    if (abbr !== last) { last = abbr; deps.onCwd(abbr) }
  }
}
