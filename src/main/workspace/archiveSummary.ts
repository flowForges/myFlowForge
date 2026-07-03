export interface SummaryDeps {
  recentText: (wsPath: string) => string
  fallbackTitle: (wsPath: string) => string
  summarize: ((prompt: string) => Promise<string>) | null
  timeoutMs?: number
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms)
    p.then(v => { clearTimeout(t); res(v) }, e => { clearTimeout(t); rej(e) })
  })
}

export async function buildArchiveSummary(wsPath: string, deps: SummaryDeps): Promise<string> {
  const fallback = (deps.fallbackTitle(wsPath) || '已归档工作区').trim()
  const body = deps.recentText(wsPath).slice(0, 4000)
  if (!body.trim() || !deps.summarize) return fallback
  try {
    const raw = await withTimeout(deps.summarize(`用一句中文(不超过 30 字)概括这个工作区的核心目标，只输出这句话：\n\n${body}`), deps.timeoutMs ?? 20000)
    const out = raw.replace(/\s+/g, ' ').trim().slice(0, 60)
    return out || fallback
  } catch { return fallback }
}
