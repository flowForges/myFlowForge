import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel } from './kernel'
import type { Plugin } from './pluginHost'
import { Sessions, validateCwd } from './sessions'
import type { KernelEvent } from '../protocol/index'
import { NO_SANDBOX } from '../../test/sandboxStub'

let dir: string // 内核数据目录
let work: string // 放工作目录的地方
let kernels: Kernel[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mffai-sessions-'))
  work = mkdtempSync(join(tmpdir(), 'mffai-cwd-'))
})
afterEach(async () => {
  for (const k of kernels) await k.close().catch(() => {})
  kernels = []
  rmSync(dir, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})

let seen: Sessions | undefined
const probe: Plugin = {
  manifest: { id: 'probe', version: '0', kernel: '^0.1.0' },
  activate: ctx => { seen = ctx.services.get<Sessions>('sessions') },
}
async function boot() {
  seen = undefined
  const k = await createKernel({ sandbox: NO_SANDBOX, dataDir: dir, plugins: [probe], home: work, secrets: { osBackend: false } })
  kernels.push(k)
  return k
}
const create = (k: Kernel, params: object, commandId = 'c') =>
  k.handle('session.create', { commandId, ...params }) as Promise<{ sessionId: string }>
const codeOf = (p: Promise<unknown>) => p.then(() => undefined, (e: { code?: number }) => e.code)
const createdPayload = (k: Kernel, sessionId: string) =>
  k.events.bySession(sessionId).find(e => e.type === 'session.created')!.payload as Record<string, unknown>

describe('session.create options', () => {
  it('writes approvalMode (default ask), toolset and model into session.created', async () => {
    const k = await boot()
    const a = await create(k, { title: 't' }, 'a')
    expect(createdPayload(k, a.sessionId)).toEqual({ title: 't', approvalMode: 'ask' })
    const b = await create(k, { approvalMode: 'auto', toolset: 'edit', model: { accountId: 'x', modelId: 'm' } }, 'b')
    expect(createdPayload(k, b.sessionId)).toEqual({ approvalMode: 'auto', toolset: 'edit', model: { accountId: 'x', modelId: 'm' } })
  })

  it('rejects approvalMode outside ask/auto', async () => {
    const k = await boot()
    expect(await codeOf(create(k, { approvalMode: 'yolo' }))).toBe(-32602)
  })

  it('rejects a relative, missing, file or root cwd with -32602 and writes nothing', async () => {
    const k = await boot()
    writeFileSync(join(work, 'f.txt'), 'x')
    for (const cwd of ['rel/dir', join(work, 'missing'), join(work, 'f.txt'), '/']) {
      await expect(create(k, { cwd }, `c-${cwd}`)).rejects.toMatchObject({ code: -32602, message: 'invalid cwd' })
    }
    expect(k.events.after(0).filter(e => e.type === 'session.created')).toEqual([])
    // 失败不留回执:同一 commandId 换个合法 cwd 可重试
    const ok = await create(k, { cwd: work }, `c-${join(work, 'missing')}`)
    expect(createdPayload(k, ok.sessionId).cwd).toBe(realpathSync.native(work))
  })

  it('a symlinked dir is stored as its realpath', async () => {
    const k = await boot()
    const real = join(work, 'real')
    mkdirSync(real)
    symlinkSync(real, join(work, 'link'), 'dir')
    const { sessionId } = await create(k, { cwd: join(work, 'link') })
    expect(createdPayload(k, sessionId).cwd).toBe(realpathSync.native(real))
    expect(seen!.get(sessionId)?.cwd).toBe(realpathSync.native(real))
  })
})

describe('Sessions service', () => {
  it('is provided before plugins activate and tracks new sessions', async () => {
    const k = await boot()
    expect(seen).toBeInstanceOf(Sessions)
    const { sessionId } = await create(k, { cwd: work, approvalMode: 'auto', toolset: 'patch', model: { accountId: 'a', modelId: 'm' } })
    expect(seen!.get(sessionId)).toEqual({
      sessionId, cwd: realpathSync.native(work), approvalMode: 'auto', toolset: 'patch', model: { accountId: 'a', modelId: 'm' }, origin: 'app',
    })
    expect(seen!.get('nope')).toBeUndefined()
  })

  it('rebuilds from the event log after a kernel restart', async () => {
    const k1 = await boot()
    const a = await create(k1, { cwd: work, toolset: 'edit' }, 'a')
    const b = await create(k1, {}, 'b')
    await k1.close()
    kernels = []
    await boot()
    expect(seen!.get(a.sessionId)).toEqual({ sessionId: a.sessionId, cwd: realpathSync.native(work), approvalMode: 'ask', toolset: 'edit', origin: 'app' })
    expect(seen!.get(b.sessionId)).toEqual({ sessionId: b.sessionId, approvalMode: 'ask', origin: 'app' })
  })

  it('load / observe only read session.created; old payloads default to ask', () => {
    const s = new Sessions(dir)
    const ev = (seq: number, type: KernelEvent['type'], sessionId: string | undefined, payload: unknown): KernelEvent =>
      ({ seq, ts: 0, type, sessionId, payload })
    s.load([ev(1, 'session.created', 's1', { title: 'old' }), ev(2, 'message.user', 's1', { cwd: '/x' }), ev(3, 'session.created', undefined, {})])
    expect(s.get('s1')).toEqual({ sessionId: 's1', approvalMode: 'ask', origin: 'app' })
    s.observe(ev(4, 'session.created', 's2', { approvalMode: 'auto', cwd: '/w' }))
    expect(s.get('s2')).toEqual({ sessionId: 's2', approvalMode: 'auto', cwd: '/w', origin: 'app' })
  })

  it('origin round-trips through session.create; session.created carries it only when not app', async () => {
    const k = await boot()
    const im = await create(k, { origin: 'im' }, 'im')
    const schedule = await create(k, { origin: 'schedule' }, 'schedule')
    const app = await create(k, { origin: 'app' }, 'app')
    const none = await create(k, {}, 'none')
    expect(seen!.get(im.sessionId)?.origin).toBe('im')
    expect(seen!.get(schedule.sessionId)?.origin).toBe('schedule')
    expect(seen!.get(app.sessionId)?.origin).toBe('app')
    expect(seen!.get(none.sessionId)?.origin).toBe('app')
    expect(createdPayload(k, im.sessionId).origin).toBe('im')
    expect(createdPayload(k, schedule.sessionId).origin).toBe('schedule')
    expect(createdPayload(k, app.sessionId)).not.toHaveProperty('origin')
    expect(createdPayload(k, none.sessionId)).not.toHaveProperty('origin')
    expect(await codeOf(create(k, { origin: 'cron' }, 'bad'))).toBe(-32602)
  })

  it('origin survives a kernel restart', async () => {
    const k1 = await boot()
    const im = await create(k1, { origin: 'im' }, 'im')
    await k1.close()
    kernels = []
    await boot()
    expect(seen!.get(im.sessionId)?.origin).toBe('im')
  })

  it('only an absent origin reads as app; an unrecognised one is never treated as app', () => {
    const s = new Sessions(dir)
    const ev = (sessionId: string, payload: unknown): KernelEvent => ({ seq: 1, ts: 0, type: 'session.created', sessionId, payload })
    s.load([
      ev('old', { title: 'old' }),
      ev('noPayload', null),
      ev('app', { origin: 'app' }),
      ev('im', { origin: 'im' }),
      ev('schedule', { origin: 'schedule' }),
      ev('newer', { origin: 'webhook' }),
      ev('nullish', { origin: null }),
      ev('number', { origin: 3 }),
    ])
    for (const id of ['old', 'noPayload', 'app']) expect(s.get(id)?.origin).toBe('app')
    expect(s.get('im')?.origin).toBe('im')
    for (const id of ['schedule', 'newer', 'nullish', 'number']) expect(s.get(id)?.origin).toBe('schedule')
  })

  it('spillDir is dataDir/sessions/<id>/spill', () => {
    const s = new Sessions(dir)
    expect(s.spillDir('abc-1')).toBe(join(dir, 'sessions', 'abc-1', 'spill'))
    for (const bad of ['../x', 'a/b', '', '..']) expect(() => s.spillDir(bad)).toThrow()
  })
})

describe('validateCwd', () => {
  const opts = () => ({ home: work, dataDir: dir, platform: process.platform })
  it('returns the realpath of an existing absolute directory', () => {
    expect(validateCwd(work, opts())).toBe(realpathSync.native(work))
  })
  it('rejects a filesystem root', () => {
    expect(() => validateCwd('/', opts())).toThrow('invalid cwd')
  })
  it('rejects a symlink that resolves to the root', () => {
    symlinkSync('/', join(work, 'root'), 'dir')
    expect(() => validateCwd(join(work, 'root'), opts())).toThrow('invalid cwd')
  })
  it('rejects a cwd in or under a credential root, and the mff-ai dataDir', () => {
    // work / dir 未 realpath:macOS 上 /var → /private/var,比较前两边都要规范化
    for (const rel of ['.aws', '.ssh/sub', '.config/gh']) mkdirSync(join(work, rel), { recursive: true })
    for (const rel of ['.aws', '.ssh/sub', '.config/gh']) expect(() => validateCwd(join(work, rel), opts())).toThrow('invalid cwd')
    mkdirSync(join(dir, 'plugins'), { recursive: true })
    expect(() => validateCwd(dir, opts())).toThrow('invalid cwd')
    expect(() => validateCwd(join(dir, 'plugins'), opts())).toThrow('invalid cwd')
    expect(validateCwd(work, opts())).toBe(realpathSync.native(work)) // 家目录本身可以
  })
  it('rejects a cwd symlinked into a credential root', () => {
    mkdirSync(join(work, '.aws'))
    const elsewhere = mkdtempSync(join(tmpdir(), 'mffai-cwd-link-'))
    try {
      symlinkSync(join(work, '.aws'), join(elsewhere, 'proj'), 'dir')
      expect(() => validateCwd(join(elsewhere, 'proj'), opts())).toThrow('invalid cwd')
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
  it('win32: rejects share roots, \\?\ / UNC forms, ADS and drive-less paths', () => {
    const fs = { realpath: (p: string) => p, isDirectory: () => true }
    const w = { home: 'C:\\Users\\u', dataDir: 'C:\\Users\\u\\.myFlowForge\\mff-ai', platform: 'win32' as const, fs }
    for (const p of ['\\\\?\\UNC\\srv\\share\\', '\\\\srv\\share\\', '\\\\srv\\share\\proj', '\\\\?\\C:\\repo', '\\\\.\\C:\\repo',
      'C:\\repo:ads', '\\repo', 'C:\\', 'C:\\Users\\u\\.SSH', 'c:\\users\\U\\.myflowforge\\MFF-AI\\x'])
      expect(() => validateCwd(p, w), p).toThrow('invalid cwd')
    expect(validateCwd('C:\\repo', w)).toBe('C:\\repo')
  })
  it('darwin: /System/Volumes/Data is rejected (it would contain every firmlinked dir); its Users alias is not', () => {
    const fs = { realpath: (p: string) => p, isDirectory: () => true }
    const d = { home: '/Users/u', dataDir: '/Users/u/.myFlowForge/mff-ai', platform: 'darwin' as const, fs }
    for (const p of ['/System/Volumes/Data', '/System/Volumes/Data/', '/'])
      expect(() => validateCwd(p, d), p).toThrow('invalid cwd')
    expect(() => validateCwd('/System/Volumes/Data/Users/u/.ssh', d)).toThrow('invalid cwd')
    expect(validateCwd('/System/Volumes/Data/Users/x', d)).toBe('/System/Volumes/Data/Users/x')
  })
})

describe('validateCwd: env-relocated credential roots', () => {
  it('rejects a cwd inside GNUPGHOME / CLAUDE_CONFIG_DIR; ignores relative values', () => {
    mkdirSync(join(work, 'gpg', 'sub'), { recursive: true })
    mkdirSync(join(work, 'claude'))
    const env = { GNUPGHOME: join(work, 'gpg'), CLAUDE_CONFIG_DIR: join(work, 'claude') }
    const o = { home: dir, dataDir: join(dir, 'data'), platform: process.platform, env }
    for (const p of [join(work, 'gpg'), join(work, 'gpg', 'sub'), join(work, 'claude')]) expect(() => validateCwd(p, o), p).toThrow('invalid cwd')
    expect(validateCwd(work, o)).toBe(realpathSync.native(work))
    expect(validateCwd(join(work, 'gpg'), { ...o, env: { GNUPGHOME: 'gpg' } })).toBe(realpathSync.native(join(work, 'gpg')))
  })
})
