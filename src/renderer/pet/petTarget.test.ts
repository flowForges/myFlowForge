import { describe, it, expect } from 'vitest'
import { petTgt, sessLabel } from './petTarget'
import type { PetTarget } from './petTarget'
import type { SessionsFile, ChatSession } from '@shared/types'

// Helper to build a minimal SessionsFile
function makeSF(sessions: ChatSession[], activeSessionId: string): SessionsFile {
  return { sessions, activeSessionId }
}

const s1: ChatSession = { id: 's1', title: '未命名会话', mode: 'chat', createdAt: 1 }
const s2: ChatSession = { id: 's2', title: '未命名会话', mode: 'chat', createdAt: 2 }
const s3: ChatSession = { id: 's3', title: '工作流会话', mode: 'workflow', createdAt: 3 }

describe('petTgt', () => {
  it('returns the explicit target ws+sess when target points to an existing session', () => {
    const sf1 = makeSF([s1, s2], 's2')
    const sf2 = makeSF([s3], 's3')
    const sessionsByWs: Record<string, SessionsFile> = {
      '/ws/a': sf1,
      '/ws/b': sf2,
    }
    const target: PetTarget = { wsPath: '/ws/b', sessId: 's3' }
    const result = petTgt(target, sessionsByWs, '/ws/a')
    expect(result.wsPath).toBe('/ws/b')
    expect(result.ws).toBe(sf2)
    expect(result.sess).toBe(s3)
  })

  it('falls back to currentWs activeSession when target sessId does not exist', () => {
    const sf1 = makeSF([s1, s2], 's2')
    const sessionsByWs: Record<string, SessionsFile> = { '/ws/a': sf1 }
    const target: PetTarget = { wsPath: '/ws/a', sessId: 'stale-id' }
    const result = petTgt(target, sessionsByWs, '/ws/a')
    expect(result.wsPath).toBe('/ws/a')
    expect(result.ws).toBe(sf1)
    expect(result.sess).toBe(s2)  // activeSessionId = 's2'
  })

  it('falls back to currentWs activeSession when target wsPath does not exist', () => {
    const sf1 = makeSF([s1, s2], 's1')
    const sessionsByWs: Record<string, SessionsFile> = { '/ws/a': sf1 }
    const target: PetTarget = { wsPath: '/ws/gone', sessId: 's1' }
    const result = petTgt(target, sessionsByWs, '/ws/a')
    expect(result.wsPath).toBe('/ws/a')
    expect(result.ws).toBe(sf1)
    expect(result.sess).toBe(s1)
  })

  it('falls back to currentWs when target is null', () => {
    const sf1 = makeSF([s1, s3], 's3')
    const sessionsByWs: Record<string, SessionsFile> = { '/ws/a': sf1 }
    const result = petTgt(null, sessionsByWs, '/ws/a')
    expect(result.wsPath).toBe('/ws/a')
    expect(result.ws).toBe(sf1)
    expect(result.sess).toBe(s3)
  })

  it('falls back to first session when activeSessionId is not found', () => {
    const sf1 = makeSF([s1, s2], 'bad-id')
    const sessionsByWs: Record<string, SessionsFile> = { '/ws/a': sf1 }
    const result = petTgt(null, sessionsByWs, '/ws/a')
    expect(result.wsPath).toBe('/ws/a')
    expect(result.sess).toBe(s1)  // first session
  })

  it('returns null ws and sess when currentWs has no sessions data', () => {
    const result = petTgt(null, {}, '/ws/missing')
    expect(result.wsPath).toBe('/ws/missing')
    expect(result.ws).toBeNull()
    expect(result.sess).toBeNull()
  })

  it('returns null sess when sessions array is empty', () => {
    const sf1 = makeSF([], '')
    const sessionsByWs: Record<string, SessionsFile> = { '/ws/a': sf1 }
    const result = petTgt(null, sessionsByWs, '/ws/a')
    expect(result.wsPath).toBe('/ws/a')
    expect(result.ws).toBe(sf1)
    expect(result.sess).toBeNull()
  })
})

describe('sessLabel', () => {
  it('returns title as-is when session name is unique', () => {
    const sessions = [s1, s3]
    expect(sessLabel(sessions, s3)).toBe('工作流会话')
  })

  it('appends #k when multiple sessions share the same title', () => {
    const sessions = [s1, s2]
    expect(sessLabel(sessions, s1)).toBe('未命名会话 #1')
    expect(sessLabel(sessions, s2)).toBe('未命名会话 #2')
  })

  it('returns title as-is when sessions array has only one entry', () => {
    expect(sessLabel([s1], s1)).toBe('未命名会话')
  })

  it('handles three sessions with same title (correct ordering)', () => {
    const sA: ChatSession = { id: 'a', title: 'x', mode: 'chat', createdAt: 1 }
    const sB: ChatSession = { id: 'b', title: 'x', mode: 'chat', createdAt: 2 }
    const sC: ChatSession = { id: 'c', title: 'x', mode: 'chat', createdAt: 3 }
    const sessions = [sA, sB, sC]
    expect(sessLabel(sessions, sA)).toBe('x #1')
    expect(sessLabel(sessions, sB)).toBe('x #2')
    expect(sessLabel(sessions, sC)).toBe('x #3')
  })
})
