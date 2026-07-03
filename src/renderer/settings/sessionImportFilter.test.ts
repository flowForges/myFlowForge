import { describe, it, expect } from 'vitest'
import { applyImportFilter } from './sessionImportFilter'
import type { DiscoveredSession } from '@shared/types'

const mk = (id: string, src: DiscoveredSession['source'], lastTs: number): DiscoveredSession =>
  ({ source: src, externalId: id, cwd: '/r', title: id, startedAt: 0, lastTs, messageCount: 1, filePaths: [], hasBody: true })
const sessions = [mk('a', 'claude', 10), mk('b', 'codex', 30), mk('c', 'claude', 20)]
const imported = new Set(['claude::a'])

describe('applyImportFilter', () => {
  it('status=new 仅未导入, 未导入在前 + lastTs 倒序', () => {
    const out = applyImportFilter(sessions, imported, 'new', 'all')
    expect(out.map(s => s.externalId)).toEqual(['b', 'c'])
  })
  it('status=imported 仅已导入', () => {
    expect(applyImportFilter(sessions, imported, 'imported', 'all').map(s => s.externalId)).toEqual(['a'])
  })
  it('source 过滤叠加', () => {
    expect(applyImportFilter(sessions, imported, 'all', 'codex').map(s => s.externalId)).toEqual(['b'])
  })
  it('status=all: 未导入在前', () => {
    expect(applyImportFilter(sessions, imported, 'all', 'all').map(s => s.externalId)).toEqual(['b', 'c', 'a'])
  })
})
