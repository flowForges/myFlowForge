// 哪些 provider 的 chat() 真的把 task.sessionId 作为 CLI 原生续接传下去。
// claude.ts/cursor.ts/qoder.ts 传 --resume <id>；codex.ts 用 `exec resume <id>`；gemini 无 chat resume。
export { providerSupportsResume } from '@shared/nativeResumeProviders'
