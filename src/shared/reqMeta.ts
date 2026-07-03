// Request-card kind metadata, ported 1:1 from the prototype reqKindMeta (forge-proto-ref.html).
// Labels and SVG inner paths are verbatim from the prototype so the card matches exactly.

export type ReqKind = 'confirm' | 'input' | 'select'

const LABELS: Record<ReqKind, string> = {
  confirm: '需确认',
  input: '需输入',
  select: '需选择',
}

export function reqKindLabel(kind: ReqKind): string {
  return LABELS[kind]
}

// SVG inner markup per kind (verbatim from prototype reqKindMeta). Rendered inside
// <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">…</svg>.
export const REQ_KIND_ICON: Record<ReqKind, string> = {
  confirm: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  input: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  select: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
}
