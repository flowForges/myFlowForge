// Providers whose chat() resumes the prior turn natively (full context preserved).
// claude/cursor/qoder forward `--resume <id>`; codex uses `exec resume <id>`; opencode uses
// `run -s <sessionID>`; gemini has no chat resume.
export const NATIVE_RESUME_PROVIDERS = new Set(['claude', 'cursor', 'qoder', 'codex', 'opencode'])
export function providerSupportsResume(id: string): boolean { return NATIVE_RESUME_PROVIDERS.has(id) }

// Of the resume-capable providers, which ones RELIABLY redeliver the full prior transcript on every
// turn — so Forge can take the fast path (inject nothing, trust native --resume). Only claude's
// `--resume <id>` has proven dependable. codex (`exec resume`), cursor, qoder and opencode can
// silently start a FRESH thread when the id was rotated/GC'd; for those Forge always re-feeds the
// clamped local history as a safety net (see chatService's continuation selection), so the main agent
// never falls back to answering from only the current message. Redundant when resume works, essential
// when it doesn't.
export const RESUME_RELIABLE_PROVIDERS = new Set(['claude'])
export function providerResumeReliable(id: string): boolean { return RESUME_RELIABLE_PROVIDERS.has(id) }
