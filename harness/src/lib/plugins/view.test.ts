import { describe, expect, it } from 'vitest'
import type { KernelEvent } from '../../protocol/index'
import { pluginBlockOf, pluginViewOf } from './view'

let seq = 0
const ev = (type: KernelEvent['type'], payload: unknown): KernelEvent => ({ seq: ++seq, ts: seq, type, sessionId: 's', payload })
const inj = (text: string, skill = true, mcp = false) => ev('plugins.injected', { turnId: 't', text, skill, mcp })

describe('pluginViewOf, pluginBlockOf', () => {
  it('no event: no view, no block', () => {
    const log = [ev('turn.started', { turnId: 't' })]
    expect(pluginViewOf(log)).toBeUndefined()
    expect(pluginBlockOf(log)).toBeUndefined()
  })

  it('reads the flags and the text', () => {
    const log = [inj('<i/>', false, true)]
    expect(pluginViewOf(log)).toEqual({ skill: false, mcp: true })
    expect(pluginBlockOf(log)).toBe('<i/>')
  })

  it('the first counts, however many follow', () => {
    const log = [inj('<a/>', true, false), inj('<b/>', false, true)]
    expect(pluginViewOf(log)).toEqual({ skill: true, mcp: false })
    expect(pluginBlockOf(log)).toBe('<a/>')
  })

  it('a rolled-back turn changes nothing', () => {
    const log = [inj('<a/>'), ev('turn.rolledBack', { turnId: 't' })]
    expect(pluginViewOf(log)).toEqual({ skill: true, mcp: false })
    expect(pluginBlockOf(log)).toBe('<a/>')
  })

  it('both read the same event: a malformed one is skipped by both', () => {
    for (const bad of [{ turnId: 't', text: 1, skill: true, mcp: true }, { turnId: 't', text: 'x', skill: 'yes', mcp: true }, { turnId: 't', text: 'x', skill: true }, null, 'nope']) {
      const log = [ev('plugins.injected', bad), inj('<good/>', true, false)]
      expect(pluginViewOf(log)).toEqual({ skill: true, mcp: false })
      expect(pluginBlockOf(log)).toBe('<good/>')
    }
  })

  it('other sessions are not its business: it only reads what it is given', () => {
    expect(pluginViewOf([])).toBeUndefined()
  })
})
