// 运行和 IM worktree 的 停止/合并/丢弃 共用一个动作执行器(Task 8 评审):refusalOf 和重试规则只有一份
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, renderHook } from '@testing-library/react'
import { refusalOf, useActionRunner } from './actions'
import { callError } from './test/fakeForge'

describe('refusalOf', () => {
  it('reads a -32602 with a string reason; paths and restored typed', () => {
    expect(refusalOf(callError(-32602, 'x', { reason: 'dirty', paths: ['a', 1, 'b'], restored: false }))).toEqual({ reason: 'dirty', paths: ['a', 'b'], restored: false })
    expect(refusalOf(callError(-32602, 'x', { reason: 'conflict' }))).toEqual({ reason: 'conflict' })
  })
  it('anything else is not a refusal', () => {
    expect(refusalOf(callError(-32603, 'x', { reason: 'dirty' }))).toBeUndefined()
    expect(refusalOf(callError(-32602, 'x', { reason: 3 }))).toBeUndefined()
    expect(refusalOf(new Error('x'))).toBeUndefined()
  })
})

describe('useActionRunner', () => {
  it('a retry after a failure reuses the commandId; success or a refusal starts a fresh one; fresh actions always get a new id', async () => {
    const { result } = renderHook(() => useActionRunner<'stop' | 'merge'>({ scope: 'k', fresh: ['stop'], log: 'mffai test' }))
    const ids: string[] = []
    const failing = async (id: string) => { ids.push(id); throw callError(-32010, 'timeout') }
    const ok = async (id: string) => { ids.push(id) }
    await act(async () => { await result.current.run('merge', failing) })
    expect(result.current.failed).toEqual({ action: 'merge', busy: false })
    await act(async () => { await result.current.run('merge', ok) })
    expect(ids[0]).toBe(ids[1])
    expect(result.current.failed).toBeNull()
    await act(async () => { await result.current.run('merge', ok) })
    expect(ids[2]).not.toBe(ids[1])
    await act(async () => { await result.current.run('merge', async (id) => { ids.push(id); throw callError(-32602, 'r', { reason: 'dirty' }) }) })
    expect(result.current.refusal).toEqual({ reason: 'dirty' })
    await act(async () => { await result.current.run('merge', ok) })
    expect(ids[4]).not.toBe(ids[3])
    await act(async () => { await result.current.run('stop', failing) })
    await act(async () => { await result.current.run('stop', ok) })
    expect(ids[6]).not.toBe(ids[5])
  })
  it('-32003 is 忙; two runs in the same frame send once', async () => {
    const { result } = renderHook(() => useActionRunner<'merge'>({ scope: 'k', log: 'mffai test' }))
    let n = 0
    await act(async () => {
      const a = result.current.run('merge', async () => { n++; throw callError(-32003, 'busy') })
      const b = result.current.run('merge', async () => { n++ })
      await Promise.all([a, b])
    })
    expect(n).toBe(1)
    expect(result.current.failed).toEqual({ action: 'merge', busy: true })
  })
  it('RunCard and TasksPage both use it: neither keeps its own refusalOf or runner', () => {
    for (const f of ['chat/RunCard.tsx', 'tasks/TasksPage.tsx']) {
      const src = readFileSync(join(__dirname, f), 'utf8')
      expect(src, f).not.toMatch(/function refusalOf|inflight\.current = true/)
      expect(src, f).toMatch(/from '\.\.\/actions'/)
    }
  })
})
