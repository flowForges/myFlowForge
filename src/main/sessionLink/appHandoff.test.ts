import { it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let home: string
let ws: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-hand-'))
  process.env.HOME = home
  ws = join(home, 'ws')
  vi.resetModules()
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const mkDeps = (over: Record<string, unknown> = {}) => {
  const log: string[] = []
  const deps = {
    platform: 'darwin' as NodeJS.Platform,
    appInstalled: vi.fn((_app: string) => true),
    openApp: vi.fn(async (app: string) => { log.push(`open ${app}`) }),
    copy: vi.fn((t: string) => { log.push(`copy ${t}`) }),
    stopClaude: vi.fn(async (cwd: string, id: string) => { log.push(`stop ${cwd} ${id}`) }),
    codexReaped: vi.fn(async (id: string) => { log.push(`reaped ${id}`) }),
    ...over,
  }
  return { deps, log }
}

it('targets: only bound linkable providers, only on darwin, only when the app is installed', async () => {
  const { writeSession } = await import('../chat/chatStore')
  const { handoffTargets } = await import('./appHandoff')
  writeSession(ws, 's1', 'claude', 'c-1')
  writeSession(ws, 's1', 'codex', 'th-1')
  writeSession(ws, 's1', 'gemini', 'g-1')   // 不是能互通的那三家
  const { deps } = mkDeps()
  expect(handoffTargets(ws, 's1', deps)).toEqual([
    { agent: 'codex', app: 'Codex', disabled: false },
    { agent: 'claude', app: 'Claude', disabled: false },
  ])
  expect(handoffTargets(ws, 's-none', deps)).toEqual([])
  expect(handoffTargets(ws, 's1', { ...deps, platform: 'linux' })).toEqual([])
  const onlyClaude = mkDeps({ appInstalled: vi.fn((app: string) => app === 'Claude') }).deps
  expect(handoffTargets(ws, 's1', onlyClaude)).toEqual([{ agent: 'claude', app: 'Claude', disabled: false }])
  expect(onlyClaude.appInstalled).toHaveBeenCalledWith('Codex')
})

it('targets: disabled while our own turn on that provider is in flight', async () => {
  const { writeSession } = await import('../chat/chatStore')
  const { beginOwnTurn } = await import('./ownTurns')
  const { handoffTargets } = await import('./appHandoff')
  writeSession(ws, 's1', 'claude', 'c-1')
  const end = beginOwnTurn(ws, 's1', 'claude')
  expect(handoffTargets(ws, 's1', mkDeps().deps)).toEqual([{ agent: 'claude', app: 'Claude', disabled: true }])
  end()
  expect(handoffTargets(ws, 's1', mkDeps().deps)[0].disabled).toBe(false)
})

it('claude: stops our lingering process first, then opens the app, then copies the id', async () => {
  const { writeSession } = await import('../chat/chatStore')
  const { handOff } = await import('./appHandoff')
  writeSession(ws, 's1', 'claude', 'c-1')
  const { deps, log } = mkDeps()
  expect(await handOff(ws, 's1', 'claude', deps)).toEqual({ ok: true, id: 'c-1', app: 'Claude' })
  expect(log).toEqual([`stop ${ws} c-1`, 'open Claude', 'copy c-1'])
  expect(deps.codexReaped).not.toHaveBeenCalled()
})

it('codex: waits for our app-server on that thread to exit, then opens Codex', async () => {
  const { writeSession } = await import('../chat/chatStore')
  const { handOff } = await import('./appHandoff')
  writeSession(ws, 's1', 'codex', 'th-1')
  const { deps, log } = mkDeps()
  expect(await handOff(ws, 's1', 'codex', deps)).toEqual({ ok: true, id: 'th-1', app: 'Codex' })
  expect(log).toEqual(['reaped th-1', 'open Codex', 'copy th-1'])
  expect(deps.stopClaude).not.toHaveBeenCalled()
})

it('qoder: nothing to let go of (the process exits each turn); opens Qoder', async () => {
  const { writeSession } = await import('../chat/chatStore')
  const { handOff } = await import('./appHandoff')
  writeSession(ws, 's1', 'qoder', 'q-1')
  const { deps, log } = mkDeps()
  expect(await handOff(ws, 's1', 'qoder', deps)).toEqual({ ok: true, id: 'q-1', app: 'Qoder' })
  expect(log).toEqual(['open Qoder', 'copy q-1'])
})

it('refuses without side effects: our turn in flight, no binding, app missing, not darwin', async () => {
  const { writeSession } = await import('../chat/chatStore')
  const { beginOwnTurn } = await import('./ownTurns')
  const { handOff } = await import('./appHandoff')
  writeSession(ws, 's1', 'claude', 'c-1')
  const end = beginOwnTurn(ws, 's1', 'claude')
  let m = mkDeps()
  expect(await handOff(ws, 's1', 'claude', m.deps)).toEqual({ ok: false, code: 'busy' })
  expect(m.log).toEqual([])
  end()
  m = mkDeps()
  expect(await handOff(ws, 's1', 'codex', m.deps)).toEqual({ ok: false, code: 'unavailable' })
  expect(await handOff(ws, 's1', 'gemini', m.deps)).toEqual({ ok: false, code: 'unavailable' })
  expect(await handOff(ws, 's1', 'claude', { ...m.deps, appInstalled: () => false })).toEqual({ ok: false, code: 'unavailable' })
  expect(await handOff(ws, 's1', 'claude', { ...m.deps, platform: 'win32' })).toEqual({ ok: false, code: 'unavailable' })
  expect(m.log).toEqual([])
})

it('open failing: reported, nothing copied; a failing stop does not block the handoff', async () => {
  const { writeSession } = await import('../chat/chatStore')
  const { handOff } = await import('./appHandoff')
  writeSession(ws, 's1', 'claude', 'c-1')
  let m = mkDeps({ openApp: vi.fn(async () => { throw new Error('no app') }) })
  expect(await handOff(ws, 's1', 'claude', m.deps)).toEqual({ ok: false, code: 'open_failed' })
  expect(m.deps.copy).not.toHaveBeenCalled()
  m = mkDeps({ stopClaude: vi.fn(async () => { throw new Error('gone') }) })
  expect(await handOff(ws, 's1', 'claude', m.deps)).toMatchObject({ ok: true })
})

it('default opener runs `open -a <App>` via execFile (no shell); detection looks in the Applications folders', async () => {
  const execFile = vi.fn((_cmd: string, _args: string[], cb: (e: Error | null) => void) => cb(null))
  const { openAppWith, appInstalledIn } = await import('./appHandoff')
  await openAppWith(execFile as any)('Claude')
  expect(execFile).toHaveBeenCalledWith('open', ['-a', 'Claude'], expect.any(Function))
  const failing = vi.fn((_c: string, _a: string[], cb: (e: Error | null) => void) => cb(new Error('x')))
  await expect(openAppWith(failing as any)('Nope')).rejects.toThrow()
  const seen: string[] = []
  const installed = appInstalledIn(['/Applications', '/Users/u/Applications'], (p) => { seen.push(p); return p === '/Users/u/Applications/Codex.app' })
  expect(installed('Codex')).toBe(true)
  expect(installed('Qoder')).toBe(false)
  expect(seen).toContain('/Applications/Qoder.app')
})
