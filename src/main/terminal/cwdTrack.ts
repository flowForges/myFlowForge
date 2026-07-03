// OSC 7 directory report: ESC ] 7 ; file://<host><path> (BEL | ST). Many shells with integration emit it
// on each prompt; gives an instant cwd without spawning anything.
export function parseOsc7(data: string): string | null {
  const m = data.match(/\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b]*)(?:\x07|\x1b\\)/)
  if (!m) return null
  try { return decodeURIComponent(m[1]) } catch { return m[1] }
}

// `lsof -a -p <pid> -d cwd -Fn` prints: p<pid>\nfcwd\nn<path>. We want the n-line path. Shell-agnostic
// fallback when OSC 7 isn't emitted.
export function parseLsofCwd(out: string): string | null {
  const line = out.split('\n').find(l => l.startsWith('n'))
  return line ? line.slice(1) : null
}

export function abbreviateHome(path: string, home: string): string {
  if (home && (path === home || path.startsWith(home + '/'))) return '~' + path.slice(home.length)
  return path
}
