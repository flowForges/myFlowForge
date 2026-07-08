export interface Notif {
  ic: 'ok' | 'warn' | 'file'
  cls: string
  t: string
  m: string
  unread: boolean
  // Jump-to-source: where clicking this notification should navigate. `wsPath` is authoritative
  // when known (from a run's workspacePath); `wsName` is a fallback the click handler resolves to a
  // path via the workspace registry (for events that only carry a name). Absent → not clickable.
  wsPath?: string
  wsName?: string
}

export const ICN: Record<'ok' | 'warn' | 'file' | 'up', string> = {
  ok:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="20 6 9 17 4 12"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  up:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
}

export function unreadCount(ns: Notif[]): number {
  return ns.filter(n => n.unread).length
}

export function badgeText(unread: number, updateAvailable: boolean): string {
  const u = unread + (updateAvailable ? 1 : 0)
  return u > 9 ? '9+' : String(u)
}

export function markAllRead(ns: Notif[]): Notif[] {
  return ns.map(n => ({ ...n, unread: false }))
}

// Invariant guard: the bell badge and the popover content must never disagree.
// The badge is non-'0' whenever there are unread notifs OR an update is available;
// the popover must therefore always show at least one of: notif rows, or the update
// card (rendered on `updateAvailable`). This function encodes "what the popover will
// render", so `badgeText(...) !== '0'` must imply `hasPopoverContent(...) === true`.
export function hasPopoverContent(notifs: Notif[], updateAvailable: boolean): boolean {
  return updateAvailable || notifs.length > 0
}

// Strip all tags, then escape residual specials. Agent/workspace names flow into notification
// titles that are rendered as fixed-template HTML, so real data must be sanitized first.
export function formatBytes(n: number): string {
  return (n / (1024 * 1024)).toFixed(1) + ' MB'
}

export function releaseSummary(notes: string): string {
  const line = String(notes).split('\n').map(l => l.trim()).find(l => l && !/^#/.test(l)) ?? ''
  const clean = line.replace(/^#+\s*/, '').replace(/[*_`>]/g, '').trim()
  return clean.length > 40 ? clean.slice(0, 39) + '…' : clean
}

export function sanitize(s: string): string {
  const noTags = String(s).replace(/<[^>]*>/g, '')
  return noTags
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface LifecycleNote {
  // 'run-done' = the whole workflow finished (one aggregate notif, replacing per-agent 完成 spam).
  kind: 'run-done' | 'stalled' | 'awaiting' | 'failed'
  agentName: string
  wsName: string
  wsPath?: string
  silentMs?: number
}

export function notifFromLifecycle(e: LifecycleNote): Notif {
  const name = sanitize(e.agentName)
  const ws = sanitize(e.wsName)
  const route = { wsPath: e.wsPath, wsName: e.wsName }
  switch (e.kind) {
    case 'run-done':
      return { ic: 'ok', cls: 'ni-ok', t: `<b>${ws}</b> 工作流已全部完成`, m: `${ws} · 刚刚`, unread: true, ...route }
    case 'stalled': {
      const secs = e.silentMs ? Math.round(e.silentMs / 1000) : 90
      return { ic: 'warn', cls: 'ni-warn', t: `<b>${name}</b> 疑似卡住(${secs}s 无响应)`, m: `${ws} · 刚刚`, unread: true, ...route }
    }
    case 'awaiting':
      return { ic: 'warn', cls: 'ni-warn', t: `<b>${name}</b> 需要你确认/输入`, m: `${ws} · 刚刚`, unread: true, ...route }
    case 'failed':
      return { ic: 'warn', cls: 'ni-warn', t: `<b>${name}</b> 失败/被终止`, m: `${ws} · 刚刚`, unread: true, ...route }
  }
}
