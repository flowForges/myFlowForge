// Large-paste offloading for the composer. Pasting a very large blob (e.g. a 500KB JSON) into the
// controlled <textarea value={text}> makes every subsequent keystroke re-render + reflow the giant
// value, so typing visibly lags behind the IME. Instead, when a paste is huge we write it to a temp
// file (reusing the existing savePaste attachment pipeline) and show it as an attachment chip — the
// textarea stays tiny, the chip is one-click removable, and the agent reads the file via the 附件 path.

// Only offload genuinely large pastes — a few thousand chars type fine and turning them into files
// would be surprising. ~10k chars is where the controlled-textarea reflow starts to bite.
export const PASTE_OFFLOAD_THRESHOLD = 10_000

export function shouldOffloadPaste(text: string): boolean {
  return text.length >= PASTE_OFFLOAD_THRESHOLD
}

const pad = (n: number) => String(n).padStart(2, '0')

// Name the temp file. Detect JSON (opening/closing bracket) for a .json extension so the agent + the
// chip read naturally; everything else is .txt. Timestamped to avoid collisions within a workspace.
export function pastedFileName(text: string, now: Date): string {
  const t = text.trim()
  const looksJson = /^[[{]/.test(t) && /[}\]]$/.test(t)
  const ext = looksJson ? 'json' : 'txt'
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `pasted-${stamp}.${ext}`
}

// Base64-encode UTF-8 text for the savePaste IPC (which base64-decodes to bytes). btoa alone breaks on
// non-Latin1 (CJK), so encode to UTF-8 bytes first. Chunked to avoid a huge apply() arg spread.
export function base64OfUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}
