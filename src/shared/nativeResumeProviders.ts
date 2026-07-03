// Providers whose chat() resumes the prior turn natively (full context preserved).
// claude/cursor/qoder forward `--resume <id>`; codex uses `exec resume <id>`; gemini has no chat resume.
export const NATIVE_RESUME_PROVIDERS = new Set(['claude', 'cursor', 'qoder', 'codex'])
export function providerSupportsResume(id: string): boolean { return NATIVE_RESUME_PROVIDERS.has(id) }
