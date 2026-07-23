import { describe, it, expect } from 'vitest'
import { parseChatStreamActions } from './chatStream'

describe('parseChatStreamActions tool/file kinds', () => {
  // tool/file actions now also carry `name` (raw tool name) + `id` (tool_use id, when the block has one)
  // so the adapter can surface a correlated 执行-block activity.
  it('Edit/Write 工具 → file kind', () => {
    const obj = { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: 'a.ts' } } } }
    expect(parseChatStreamActions(obj)).toEqual([{ kind: 'file', text: '调用 Edit a.ts', id: 'tu1', name: 'Edit' }])
  })
  it('Bash 工具 → tool kind', () => {
    const obj = { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'go build' } } } }
    expect(parseChatStreamActions(obj)).toEqual([{ kind: 'tool', text: '调用 Bash: go build', id: 'tu2', name: 'Bash' }])
  })
  it('assistant 消息块里的 tool_use 也分流(Write→file)', () => {
    const obj = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu3', name: 'Write', input: { file_path: 'b.ts' } }] } }
    expect(parseChatStreamActions(obj)).toEqual([{ kind: 'file', text: '调用 Write b.ts', id: 'tu3', name: 'Write' }])
  })
  it('MultiEdit → file kind', () => {
    const obj = { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'MultiEdit', input: { file_path: 'c.ts' } } } }
    expect(parseChatStreamActions(obj)).toEqual([{ kind: 'file', text: '调用 MultiEdit c.ts', name: 'MultiEdit' }])
  })
  it('Read 工具 → tool kind (非文件编辑)', () => {
    const obj = { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read', input: { file_path: 'pkg/main.go' } } } }
    expect(parseChatStreamActions(obj)).toEqual([{ kind: 'tool', text: '调用 Read pkg/main.go', name: 'Read' }])
  })
})
