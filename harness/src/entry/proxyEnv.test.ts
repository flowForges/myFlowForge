import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROXY_KEYS, persistProxy, readSavedProxy, resolveProxyEnv, workerEnvFor } from './proxyEnv'

const APP = { MFFAI_SPAWNED_BY_APP: '1' }
const SAVED = { url: 'http://127.0.0.1:7897' }
const ALL = [...PROXY_KEYS, 'NO_PROXY', 'no_proxy']

describe('resolveProxyEnv', () => {
  it('app start with a proxy: env decides, URL written, flag removed, NODE_USE_ENV_PROXY on', () => {
    const r = resolveProxyEnv({ ...APP, PATH: '/b', HTTPS_PROXY: 'http://a:1', HTTP_PROXY: 'http://b:2' }, SAVED)
    expect(r.write).toEqual({ url: 'http://a:1' })
    expect(r.remove).toBeUndefined()
    expect(r.env.MFFAI_SPAWNED_BY_APP).toBeUndefined()
    expect(r.env.NODE_USE_ENV_PROXY).toBe('1')
    expect(r.env.PATH).toBe('/b')
  })
  it('app start: lowercase-only env counts; order is HTTPS, ALL, HTTP', () => {
    expect(resolveProxyEnv({ ...APP, https_proxy: 'http://l:1' }, undefined).write).toEqual({ url: 'http://l:1' })
    expect(resolveProxyEnv({ ...APP, HTTP_PROXY: 'http://h:1', ALL_PROXY: 'socks5://s:1' }, undefined).write).toEqual({ url: 'socks5://s:1' })
    expect(resolveProxyEnv({ ...APP, HTTP_PROXY: 'http://h:1' }, undefined).write).toEqual({ url: 'http://h:1' })
  })
  it('app start without a proxy: the saved one is not used, the file is removed', () => {
    const r = resolveProxyEnv({ ...APP, PATH: '/b' }, SAVED)
    expect(r.remove).toBe(true)
    expect(r.write).toBeUndefined()
    expect(r.env.HTTPS_PROXY).toBeUndefined()
    expect(r.env.NODE_USE_ENV_PROXY).toBeUndefined()
    expect(r.env.MFFAI_SPAWNED_BY_APP).toBeUndefined()
  })
  it('login-item start: a proxy in env wins over the file and nothing is written or removed', () => {
    const r = resolveProxyEnv({ all_proxy: 'socks5://x:1' }, SAVED)
    expect(r.env.all_proxy).toBe('socks5://x:1')
    expect(r.env.HTTPS_PROXY).toBeUndefined()
    expect(r.env.NODE_USE_ENV_PROXY).toBe('1')
    expect(r.write).toBeUndefined()
    expect(r.remove).toBeUndefined()
  })
  it('login-item start: the saved proxy fills all six keys, NO_PROXY is kept and extended, a socks5 URL passes through', () => {
    for (const url of ['http://127.0.0.1:7897', 'socks5://127.0.0.1:1080']) {
      const r = resolveProxyEnv({ PATH: '/b', NO_PROXY: 'corp' }, { url })
      for (const k of PROXY_KEYS) expect(r.env[k]).toBe(url)
      expect(r.env.NO_PROXY).toBe('corp,localhost,127.0.0.1')
      expect(r.env.no_proxy).toBe('corp,localhost,127.0.0.1')
      expect(r.env.NODE_USE_ENV_PROXY).toBe('1')
    }
    expect(resolveProxyEnv({ no_proxy: 'lc' }, SAVED).env.NO_PROXY).toBe('lc,localhost,127.0.0.1')
    expect(resolveProxyEnv({}, SAVED).env.NO_PROXY).toBe('localhost,127.0.0.1')
  })
  it('login-item start, nothing saved, no proxy: untouched, no NODE_USE_ENV_PROXY', () => {
    const r = resolveProxyEnv({ PATH: '/b' }, undefined)
    expect(r).toEqual({ env: { PATH: '/b' } })
  })
  it('does not mutate its input', () => {
    const env = { ...APP, HTTPS_PROXY: 'http://a:1' }
    resolveProxyEnv(env, SAVED)
    expect(env).toEqual({ ...APP, HTTPS_PROXY: 'http://a:1' })
  })
})

describe('proxy file io', () => {
  let dir: string
  let file: string
  const lines: string[] = []
  const log = { info: (m: string, d?: unknown) => lines.push(m + JSON.stringify(d ?? '')), warn: (m: string, d?: unknown) => lines.push(m + JSON.stringify(d ?? '')), error: vi.fn() }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mffai-proxy-')); file = join(dir, 'proxy.json'); lines.length = 0 })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes atomically with mode 0600 and leaves no tmp file', () => {
    persistProxy(file, { write: { url: 'http://u:p@127.0.0.1:1' } }, log)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ url: 'http://u:p@127.0.0.1:1' })
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['proxy.json'])
  })
  it('an existing wider-mode file is replaced by a 0600 one', () => {
    writeFileSync(file, '{}', { mode: 0o644 })
    persistProxy(file, { write: { url: 'http://x:1' } }, log)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })
  it('remove deletes the file; removing a missing file is fine', () => {
    persistProxy(file, { write: { url: 'http://x:1' } }, log)
    persistProxy(file, { remove: true }, log)
    expect(existsSync(file)).toBe(false)
    persistProxy(file, { remove: true }, log)
  })
  it('unreadable, garbage, wrong shape, control characters, oversized: all absent, and the log has no content', () => {
    const secret = 'http://user:hunter2@127.0.0.1:9'
    for (const body of ['not json ' + secret, '{"url":123}', '[]', 'null', JSON.stringify({ url: secret + '\nX' }), JSON.stringify({ url: 'http://' + 'a'.repeat(3000) })]) {
      writeFileSync(file, body)
      expect(readSavedProxy(file, log)).toBeUndefined()
    }
    expect(readSavedProxy(join(dir, 'nope.json'), log)).toBeUndefined()
    expect(readSavedProxy(dir, log)).toBeUndefined() // a directory: EISDIR
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join('\n')).not.toMatch(/hunter2|user:|127\.0\.0\.1/)
  })
  it('a proxy URL with userinfo appears in no log line through the whole flow', () => {
    const url = 'http://user:hunter2@proxy.example:8080'
    const app = workerEnvFor({ ...APP, HTTPS_PROXY: url }, file, log)
    expect(app.HTTPS_PROXY).toBe(url) // the worker gets it
    expect(app.MFFAI_SPAWNED_BY_APP).toBeUndefined()
    const login = workerEnvFor({ PATH: '/b' }, file, log)
    for (const k of PROXY_KEYS) expect(login[k]).toBe(url)
    writeFileSync(file, '{"url":"http://user:hunter2@x"') // truncated
    workerEnvFor({ PATH: '/b' }, file, log)
    const cleared = workerEnvFor({ ...APP }, file, log)
    expect(cleared.HTTPS_PROXY).toBeUndefined()
    expect(existsSync(file)).toBe(false)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join('\n')).not.toMatch(/hunter2|proxy\.example|user:/)
  })
  it('workerEnvFor with all eight vars set and no flag: file is neither read nor changed', () => {
    persistProxy(file, { write: { url: 'http://saved:1' } }, log)
    const env: NodeJS.ProcessEnv = {}
    for (const k of ALL) env[k] = 'http://env:1'
    const r = workerEnvFor(env, file, log)
    expect(r.HTTPS_PROXY).toBe('http://env:1')
    expect(JSON.parse(readFileSync(file, 'utf8')).url).toBe('http://saved:1')
  })
})
