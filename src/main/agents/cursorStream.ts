// parseCursorEvent: best-effort parser for cursor-agent --output-format stream-json
// --stream-partial-output output shapes. The real shape is UNVERIFIED — cursor must be
// logged in to generate real output. These shapes are inferred from cursor's Claude-Code-
// compatible CLI design and common stream-json conventions.
//
// Assumed shapes handled (tolerant of missing fields):
//   assistant text:    { type:'assistant', message:{ content:[{ type:'text', text:'...' }] } }  → output
//   partial text:      { type:'assistant', delta:{ text:'...' } }                               → output
//   flat text:         { type:'text', text:'...' }                                              → output
//   thinking block:    { type:'assistant', message:{ content:[{ type:'thinking', thinking:'..' }] } } → think
//   tool_use block:    content item { type:'tool_use', name:'Edit', input:{file_path} }        → file/tool
//   result/final:      { type:'result', result:'...' }                                          → output
//
// ⚠️ SHAPE IS ASSUMED — needs login + real cursor output to verify. Provider's fence scanner
// and fail-open (unparsed lines → info) cover divergence at runtime.

export type CursorEventKind = 'think' | 'tool' | 'file' | 'output'
export interface CursorEvent { kind: CursorEventKind; text: string }

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'apply_patch'])

function clip(v: unknown): string {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  return s.length > 200 ? s.slice(0, 200) + '…' : s
}

function toolLabel(name: string, input: any): string {
  if (input?.file_path) return `调用 ${name} ${clip(input.file_path)}`
  if (input?.path) return `调用 ${name} ${clip(input.path)}`
  if (input?.command != null) return `调用 ${name}: ${clip(input.command)}`
  if (input?.pattern != null) return `调用 ${name}: ${clip(input.pattern)}`
  if (input?.url != null) return `调用 ${name} ${clip(input.url)}`
  return `调用 ${name}`
}

function toolEvent(name: string, input: any): CursorEvent {
  return { kind: FILE_TOOLS.has(name) ? 'file' : 'tool', text: toolLabel(name, input) }
}

function handleContentBlock(b: any, out: CursorEvent[]): void {
  if (!b || typeof b !== 'object') return
  if (b.type === 'text' && typeof b.text === 'string' && b.text) {
    out.push({ kind: 'output', text: b.text })
  } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
    out.push({ kind: 'think', text: b.thinking })
  } else if (b.type === 'tool_use' && typeof b.name === 'string') {
    out.push(toolEvent(b.name, b.input))
  }
}

export function parseCursorEvent(obj: any): CursorEvent[] {
  if (!obj || typeof obj !== 'object') return []
  const out: CursorEvent[] = []

  // Shape: { type:'assistant', message:{ content:[] } } — full message with content blocks
  if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
    for (const b of obj.message.content) {
      handleContentBlock(b, out)
    }
    return out
  }

  // Shape: { type:'assistant', delta:{ text:'...' } } — streaming delta
  if (obj.type === 'assistant' && obj.delta && typeof obj.delta.text === 'string' && obj.delta.text) {
    out.push({ kind: 'output', text: obj.delta.text })
    return out
  }

  // Shape: { type:'text', text:'...' } — flat text event
  if (obj.type === 'text' && typeof obj.text === 'string' && obj.text) {
    out.push({ kind: 'output', text: obj.text })
    return out
  }

  // Shape: { type:'result', result:'...' } — final result
  if (obj.type === 'result') {
    const text = typeof obj.result === 'string' ? obj.result
      : (typeof obj.text === 'string' ? obj.text : undefined)
    if (text) out.push({ kind: 'output', text })
    return out
  }

  // Unknown shape: return [] (fail-open — provider's scanner handles it)
  return out
}
