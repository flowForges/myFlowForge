// cursorStream.test.ts
// Tests for parseCursorEvent — best-effort parser for cursor-agent stream-json shapes.
// ⚠️ Fixture shapes are ASSUMED (cursor not logged in; real output unverifiable).
// Needs login verification once cursor is authenticated.
import { describe, it, expect } from 'vitest'
import { parseCursorEvent } from './cursorStream'

describe('parseCursorEvent', () => {
  describe('assistant text (full message with content[])', () => {
    it('maps text content block to output', () => {
      const obj = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '已完成分析' }] }
      }
      const events = parseCursorEvent(obj)
      expect(events).toHaveLength(1)
      expect(events[0].kind).toBe('output')
      expect(events[0].text).toBe('已完成分析')
    })

    it('maps thinking content block to think', () => {
      const obj = {
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: '正在推理...' }] }
      }
      const events = parseCursorEvent(obj)
      expect(events).toHaveLength(1)
      expect(events[0].kind).toBe('think')
      expect(events[0].text).toBe('正在推理...')
    })

    it('maps tool_use in FILE_TOOLS to file kind', () => {
      const obj = {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/index.ts' } }] }
      }
      const events = parseCursorEvent(obj)
      expect(events).toHaveLength(1)
      expect(events[0].kind).toBe('file')
      expect(events[0].text).toContain('Edit')
      expect(events[0].text).toContain('src/index.ts')
    })

    it('maps tool_use not in FILE_TOOLS to tool kind', () => {
      const obj = {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'go build' } }] }
      }
      const events = parseCursorEvent(obj)
      expect(events).toHaveLength(1)
      expect(events[0].kind).toBe('tool')
      expect(events[0].text).toContain('Bash')
    })

    it('maps Write to file kind', () => {
      const obj = {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'out.ts' } }] }
      }
      const events = parseCursorEvent(obj)
      expect(events[0].kind).toBe('file')
    })

    it('handles mixed content blocks in one message', () => {
      const obj = {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: '分析一下' },
            { type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } },
            { type: 'text', text: '完成' },
          ]
        }
      }
      const events = parseCursorEvent(obj)
      expect(events).toHaveLength(3)
      expect(events[0].kind).toBe('think')
      expect(events[1].kind).toBe('file')
      expect(events[2].kind).toBe('output')
    })

    it('ignores unknown content block types gracefully', () => {
      const obj = {
        type: 'assistant',
        message: { content: [{ type: 'unknown_block', data: 'x' }, { type: 'text', text: 'ok' }] }
      }
      const events = parseCursorEvent(obj)
      expect(events).toHaveLength(1)
      expect(events[0].kind).toBe('output')
    })
  })

  describe('streaming deltas', () => {
    it('maps delta.text to output', () => {
      const obj = { type: 'assistant', delta: { text: '部分文本' } }
      const events = parseCursorEvent(obj)
      expect(events).toHaveLength(1)
      expect(events[0].kind).toBe('output')
      expect(events[0].text).toBe('部分文本')
    })

    it('ignores delta with empty text', () => {
      const obj = { type: 'assistant', delta: { text: '' } }
      const events = parseCursorEvent(obj)
      expect(events).toHaveLength(0)
    })
  })

  describe('flat text event', () => {
    it('maps { type:text, text } to output', () => {
      const obj = { type: 'text', text: '平文本' }
      const events = parseCursorEvent(obj)
      expect(events).toHaveLength(1)
      expect(events[0].kind).toBe('output')
      expect(events[0].text).toBe('平文本')
    })

    it('ignores flat text event with empty text', () => {
      const obj = { type: 'text', text: '' }
      expect(parseCursorEvent(obj)).toHaveLength(0)
    })
  })

  describe('result/final event', () => {
    it('maps { type:result, result } to output', () => {
      const obj = { type: 'result', result: '全部完成' }
      const events = parseCursorEvent(obj)
      expect(events).toHaveLength(1)
      expect(events[0].kind).toBe('output')
      expect(events[0].text).toBe('全部完成')
    })

    it('falls back to .text field if .result missing', () => {
      const obj = { type: 'result', text: '备用文本' }
      const events = parseCursorEvent(obj)
      expect(events[0].text).toBe('备用文本')
    })

    it('returns [] for result with no text', () => {
      const obj = { type: 'result' }
      expect(parseCursorEvent(obj)).toHaveLength(0)
    })
  })

  describe('unknown / edge cases', () => {
    it('returns [] for null', () => { expect(parseCursorEvent(null)).toHaveLength(0) })
    it('returns [] for non-object', () => { expect(parseCursorEvent('string')).toHaveLength(0) })
    it('returns [] for empty object', () => { expect(parseCursorEvent({})).toHaveLength(0) })
    it('returns [] for unknown type', () => {
      expect(parseCursorEvent({ type: 'system', msg: 'init' })).toHaveLength(0)
    })
    it('tolerates missing fields gracefully (no throws)', () => {
      expect(() => parseCursorEvent({ type: 'assistant', message: null })).not.toThrow()
      expect(() => parseCursorEvent({ type: 'assistant', message: { content: null } })).not.toThrow()
    })
  })

  describe('tool label formatting', () => {
    it('includes path in label for file tools', () => {
      const obj = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'long/path/file.ts' } }] } }
      expect(parseCursorEvent(obj)[0].text).toBe('调用 Edit long/path/file.ts')
    })

    it('includes command in label for command tools', () => {
      const obj = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }
      expect(parseCursorEvent(obj)[0].text).toBe('调用 Bash: npm test')
    })

    it('falls back to name-only label when no recognisable input field', () => {
      const obj = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Unknown', input: {} }] } }
      expect(parseCursorEvent(obj)[0].text).toBe('调用 Unknown')
    })
  })
})
