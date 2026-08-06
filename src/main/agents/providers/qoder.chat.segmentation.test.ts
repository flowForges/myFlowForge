import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeQoderProvider } from './qoder'
import type { ChatCallbacks } from '../types'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'qoder-seg-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// Reproduces the real bug: qoder's --include-partial-messages streams word-level text_delta partials
// that LACK the model's paragraph newlines (so the reply renders as one blob), while the full `assistant`
// message that follows DOES carry them. The fix captures that full text and replaces the reply body.
const FAKE_BLOB_THEN_FULL = `#!/usr/bin/env node
const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
out({ session_id: 'seg-id' })
// Streamed partials — NO paragraph newlines between the three "paragraphs" (the blob).
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '第一段原理。' } } })
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '第二段步骤。' } } })
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '第三段复杂度。' } } })
// The full assistant message carries the model's REAL newlines.
out({ type: 'assistant', message: { content: [ { type: 'text', text: '第一段原理。\\n\\n第二段步骤。\\n\\n第三段复杂度。' } ] } })
out({ type: 'result' })
process.exit(0)
`

function mkCb() {
  const state = { text: '', replaced: null as string | null, replaceCount: 0 }
  const cb: ChatCallbacks = {
    onSession: () => {},
    onAssistantDelta: t => { state.text += t },
    onAssistantReplace: t => { state.replaced = t; state.replaceCount++ },
    onThinkDelta: () => {},
    onDone: () => {},
    onError: () => {},
  }
  return { cb, state }
}

describe('qoder chat() reply segmentation', () => {
  it('replaces the newline-less streamed blob with the full message’s authoritative newlines', async () => {
    const bin = join(dir, 'qoder.js'); writeFileSync(bin, FAKE_BLOB_THEN_FULL); chmodSync(bin, 0o755)
    const provider = makeQoderProvider({ bin, defaultModels: [] })
    const { cb, state } = mkCb()
    await provider.chat!({ id: 'a1', prompt: 'hi', model: 'default', cwd: dir }, cb, process.env).done

    // The live-streamed body is the blob (no newlines) — that's what the partials carry.
    expect(state.text).toBe('第一段原理。第二段步骤。第三段复杂度。')
    // …but the reply body is corrected to the model's real paragraph structure exactly once.
    expect(state.replaceCount).toBe(1)
    expect(state.replaced).toBe('第一段原理。\n\n第二段步骤。\n\n第三段复杂度。')
    // The authoritative text has the newlines the blob lacked (the renderer segments on these).
    expect(state.replaced).toContain('\n\n')
    expect(state.text).not.toContain('\n')
  })
})
