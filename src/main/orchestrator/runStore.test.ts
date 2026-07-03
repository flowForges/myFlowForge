import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunStore, readLastRun } from './runStore'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'ws-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

const sampleRun = (over: Partial<import('@shared/types').RunState> = {}): import('@shared/types').RunState => ({
  id: 'run-x', workspaceName: 'x', workspacePath: ws, status: 'run',
  projects: [{ name: 'p', cwd: '/tmp/p' }],
  stages: [{ key: 'develop', name: '开发', state: 'run', agents: [
    { id: 'a1', name: 'a1', role: 'dev', provider: 'claude', model: 'm', state: 'run', logs: [] },
    { id: 'a2', name: 'a2', role: 'dev', provider: 'claude', model: 'm', state: 'ok', logs: [] },
  ] }],
  pending: [{ id: 'p1', kind: 'confirm', agentId: 'a1', agentName: 'a1', wsName: 'x', title: 't' }],
  ...over,
})

describe('RunStore (blackboard)', () => {
  it('creates run dir, appends messages, reads/writes context, writes artifacts', () => {
    const store = new RunStore(ws, 'run1')
    store.appendMessage({ id: 'm1', runId: 'run1', from: 'orchestrator', to: 'broadcast', type: 'status', payload: { s: 'start' }, artifacts: [], ts: 't' })
    store.setContext('requirementSummary', '迁移到 OKLch')
    expect(store.getContext('requirementSummary')).toBe('迁移到 OKLch')
    const ref = store.writeArtifact('design.md', '# 设计\n')
    expect(existsSync(join(ws, '.forge', 'runs', 'run1', 'artifacts', 'design.md'))).toBe(true)
    expect(ref.path).toContain('design.md')
    const messages = readFileSync(join(ws, '.forge', 'runs', 'run1', 'messages.jsonl'), 'utf8').trim().split('\n')
    expect(messages).toHaveLength(1)
  })

  it('keeps all keys when many setContext calls interleave', async () => {
    const store = new RunStore(ws, 'run2')
    await Promise.all(Array.from({ length: 50 }, (_, i) => Promise.resolve().then(() => store.setContext('k' + i, i))))
    for (let i = 0; i < 50; i++) expect(store.getContext('k' + i)).toBe(i)
  })

  it('rejects artifact names that escape the artifacts dir', () => {
    const store = new RunStore(ws, 'run3')
    expect(() => store.writeArtifact('../escape.md', 'x')).toThrow()
    expect(() => store.writeArtifact('/tmp/escape.md', 'x')).toThrow()
    // happy path still works:
    expect(() => store.writeArtifact('design.md', 'ok')).not.toThrow()
  })

  it('allows artifact names that merely start with dots but stay inside the dir', () => {
    const store = new RunStore(ws, 'run-dots')
    expect(() => store.writeArtifact('..notes.md', 'ok')).not.toThrow()
    expect(() => store.writeArtifact('.hidden', 'ok')).not.toThrow()
    expect(() => store.writeArtifact('a/..b.md', 'ok')).not.toThrow()
  })

  it('still rejects real traversal (.. segment / absolute / nested escape)', () => {
    const store = new RunStore(ws, 'run-esc')
    expect(() => store.writeArtifact('../escape.md', 'x')).toThrow()
    expect(() => store.writeArtifact('/tmp/escape.md', 'x')).toThrow()
    expect(() => store.writeArtifact('a/../../escape.md', 'x')).toThrow()
    expect(() => store.writeArtifact('..', 'x')).toThrow()
  })

  it('saveState writes state.json atomically; readLastRun returns normalized snapshot', () => {
    const store = new RunStore(ws, 'run-x')
    store.saveState(sampleRun())
    expect(existsSync(join(ws, '.forge/runs/run-x/state.json'))).toBe(true)
    expect(existsSync(join(ws, '.forge/runs/run-x/state.json.tmp'))).toBe(false)
    const r = readLastRun(ws)!
    expect(r.id).toBe('run-x')
    expect(r.status).toBe('err')                  // 'run' 非终态 → err
    expect(r.stages[0].state).toBe('err')
    expect(r.stages[0].agents[0].state).toBe('err') // run → err
    expect(r.stages[0].agents[1].state).toBe('ok')  // 终态保留
    expect(r.pending).toEqual([])                   // 死 run 的 pending 清空
  })

  it('readLastRun returns null when no runs / corrupt state.json', () => {
    expect(readLastRun(join(ws, 'nonexistent-sub'))).toBe(null)
    const store = new RunStore(ws, 'run-bad')
    writeFileSync(join(ws, '.forge/runs/run-bad/state.json'), '{broken', 'utf8')
    expect(readLastRun(ws)).toBe(null)
  })

  it('readLastRun picks the newest state.json by mtime', () => {
    const s1 = new RunStore(ws, 'run-old'); s1.saveState(sampleRun({ id: 'run-old', status: 'ok' }))
    const s2 = new RunStore(ws, 'run-new'); s2.saveState(sampleRun({ id: 'run-new', status: 'ok' }))
    const newer = join(ws, '.forge/runs/run-new/state.json')
    const t = new Date(Date.now() + 5000)
    utimesSync(newer, t, t)                       // 保证 mtime 严格更新（同毫秒内写两次时）
    expect(readLastRun(ws)!.id).toBe('run-new')
  })
})
