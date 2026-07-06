import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tmp: string
vi.mock('./paths', async (orig) => {
  const actual = await orig<typeof import('./paths')>()
  return { ...actual, SYS_DIR: '__REPLACED__', sysFile: (n: string) => join((globalThis as any).__SYS__, n) }
})

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'forge-')); ;(globalThis as any).__SYS__ = tmp })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('config store', () => {
  it('returns defaults when file missing, then persists and reloads', async () => {
    const { readSettings, writeSettings } = await import('./store')
    const s = readSettings()
    expect(s.appearance.theme).toBe('light')
    writeSettings({ ...s, termProxy: 'http://127.0.0.1:7897' })
    expect(readSettings().termProxy).toBe('http://127.0.0.1:7897')
  })
  it('repairs an invalid file by falling back to defaults', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(tmp, { recursive: true })
    writeFileSync(join(tmp, 'settings.json'), '{ not valid json')
    const { readSettings } = await import('./store')
    expect(readSettings().appearance.theme).toBe('light')
  })
  it('falls back to defaults on structurally-valid JSON that violates the schema', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(tmp, { recursive: true })
    // valid JSON, wrong shape — must hit the zod parse failure path, not JSON.parse
    writeFileSync(join(tmp, 'settings.json'), JSON.stringify({ appearance: { theme: 'neon' } }))
    const { readSettings } = await import('./store')
    expect(readSettings().appearance.theme).toBe('light')
  })
  it('upsertProject adds a new project and returns the full list', async () => {
    const { upsertProject, readProjects } = await import('./store')
    const list = upsertProject({ repoUrl: 'git@github.com:acme/widget.git', branch: 'dev' })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'widget', id: 'widget', repoUrl: 'git@github.com:acme/widget.git', defaultBranch: 'dev' })
    expect(readProjects().projects).toHaveLength(1)
  })

  it('upsertProject updates branch+repoUrl on re-add without duplicating (same derived id)', async () => {
    const { upsertProject } = await import('./store')
    upsertProject({ repoUrl: 'git@github.com:acme/widget.git', branch: 'master' })  // typo'd branch
    const list = upsertProject({ repoUrl: 'https://other.host/acme/widget.git', branch: 'main' })  // same name → same id, corrected
    expect(list).toHaveLength(1)                    // no duplicate row
    expect(list[0].id).toBe('widget')               // stable id
    expect(list[0].defaultBranch).toBe('main')      // re-add corrects the branch
    expect(list[0].repoUrl).toBe('https://other.host/acme/widget.git')  // and the url
  })

  it('upsertProject defaults a blank branch to main', async () => {
    const { upsertProject } = await import('./store')
    const list = upsertProject({ repoUrl: 'git@x:y/zeta.git', branch: '' })
    expect(list[0].defaultBranch).toBe('main')
  })

  it('setProjectDefaultBranch changes an existing project branch and persists', async () => {
    const { upsertProject, setProjectDefaultBranch, readProjects } = await import('./store')
    upsertProject({ repoUrl: 'git@github.com:acme/widget.git', branch: 'master' })
    const list = setProjectDefaultBranch('widget', 'main')
    expect(list[0].defaultBranch).toBe('main')
    expect(readProjects().projects[0].defaultBranch).toBe('main')  // persisted
  })

  it('setProjectDefaultBranch is a no-op for an unknown id and blank branch', async () => {
    const { upsertProject, setProjectDefaultBranch } = await import('./store')
    upsertProject({ repoUrl: 'git@github.com:acme/widget.git', branch: 'main' })
    expect(setProjectDefaultBranch('nope', 'x')[0].defaultBranch).toBe('main')      // unknown id untouched
    expect(setProjectDefaultBranch('widget', '  ')[0].defaultBranch).toBe('main')   // blank ignored
  })

  it('writes settings atomically and leaves no .tmp behind', async () => {
    const { readSettings, writeSettings } = await import('./store')
    const { defaultSettings } = await import('./schema')
    writeSettings(defaultSettings())
    const file = join(tmp, 'settings.json')
    expect(existsSync(file)).toBe(true)
    expect(existsSync(file + '.tmp')).toBe(false)
    expect(readSettings()).toEqual(defaultSettings())
  })
})
