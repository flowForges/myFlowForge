import { it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toModelVisibleHistory } from './contextRebuild'
import { buildLocalHistoryPreamble } from './continuation'
import { appendMessages } from './chatStore'
import type { ChatMessage } from '@shared/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'ctx-ext-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

const msgs: ChatMessage[] = [
  { id: 'u', who: 'user', text: '我方问', ts: '' },
  { id: 'e0', who: 'ai', text: '', ts: '', ext: { app: 'Claude', agent: 'claude', id: '', earlier: 12 } },
  { id: 'e1', who: 'user', text: 'App 问', ts: '', ext: { app: 'Claude', agent: 'claude', id: 'x' } },
  { id: 'e2', who: 'ai', text: 'App 答', ts: '', ext: { app: 'Claude', agent: 'claude', id: 'y' } },
]

it('the 更早的 N 条 row never reaches the model; app turns do (they are real conversation)', () => {
  expect(toModelVisibleHistory(ws, 's', msgs).map(m => m.text)).toEqual(['我方问', 'App 问', 'App 答'])
})

it('the incremental catch-up for a provider leaves out the app turns already in its own native session', () => {
  appendMessages(ws, 's', msgs)
  const forClaude = buildLocalHistoryPreamble(ws, 's', {}, { fromIndex: 0, skipExtOf: 'claude' })
  expect(forClaude).toContain('我方问')
  expect(forClaude).not.toContain('App 问')
  const forCodex = buildLocalHistoryPreamble(ws, 's', {}, { fromIndex: 0, skipExtOf: 'codex' })
  expect(forCodex).toContain('App 问')
})
