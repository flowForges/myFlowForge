import { describe, expect, it } from 'vitest'
import { loginShellPath, shellEnv } from './shellEnv'

const posixBase = {
  PATH: '/usr/bin:/bin',
  HOME: '/h',
  USER: 'u',
  LOGNAME: 'u',
  SHELL: '/bin/zsh',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'C',
  LC_CTYPE: 'UTF-8',
  TERM: 'xterm',
  TMPDIR: '/tmp/x',
  TZ: 'UTC',
  HTTP_PROXY: 'http://p:1',
  https_proxy: 'http://p:2',
  NO_PROXY: 'localhost',
  OPENAI_API_KEY: 'sk-abcdefghijklmnopqrstuvwxyz',
  ANTHROPIC_API_KEY: 'x',
  NODE_OPTIONS: '--require /evil.js',
  GIT_DIR: '/elsewhere',
  DYLD_INSERT_LIBRARIES: '/evil.dylib',
}

describe('shellEnv', () => {
  it('POSIX: keeps only the allowlist, adds MFFAI / GIT_TERMINAL_PROMPT / CI', () => {
    const env = shellEnv(posixBase, { platform: 'linux', home: '/h' })
    expect(env).toMatchObject({
      HOME: '/h', USER: 'u', LOGNAME: 'u', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', LC_ALL: 'C', LC_CTYPE: 'UTF-8',
      TERM: 'xterm', TMPDIR: '/tmp/x', TZ: 'UTC', HTTP_PROXY: 'http://p:1', https_proxy: 'http://p:2', NO_PROXY: 'localhost',
      MFFAI: '1', GIT_TERMINAL_PROMPT: '0', CI: '1',
    })
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'GIT_DIR', 'DYLD_INSERT_LIBRARIES']) expect(env).not.toHaveProperty(k)
  })

  it('the added variables cannot be overridden by the base', () => {
    const env = shellEnv({ ...posixBase, CI: '0', MFFAI: 'no', GIT_TERMINAL_PROMPT: '1' }, { platform: 'linux', home: '/h' })
    expect(env).toMatchObject({ MFFAI: '1', GIT_TERMINAL_PROMPT: '0', CI: '1' })
  })

  it('darwin PATH = base ∪ login ∪ fallback dirs, de-duplicated, order-preserving', () => {
    const env = shellEnv({ ...posixBase, PATH: '/usr/bin:/a:/usr/bin' }, { platform: 'darwin', home: '/h', loginPath: '/a:/b:/opt/homebrew/bin' })
    const parts = env.PATH!.split(':')
    expect(parts.slice(0, 4)).toEqual(['/usr/bin', '/a', '/b', '/opt/homebrew/bin'])
    expect(parts).toContain('/usr/local/bin')
    expect(parts).toContain('/h/.local/bin')
    expect(new Set(parts).size).toBe(parts.length)
  })

  it('darwin PATH contains /opt/homebrew/bin even with launchd minimal PATH and no login PATH', () => {
    const env = shellEnv({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, { platform: 'darwin', home: '/h' })
    expect(env.PATH!.split(':')).toContain('/opt/homebrew/bin')
  })

  it('PATH drops empty and relative entries (they resolve against the repo)', () => {
    const env = shellEnv({ PATH: ':/usr/bin::.:bin:./node_modules/.bin' }, { platform: 'linux', home: '/h', loginPath: 'x:/b:' })
    const parts = env.PATH!.split(':')
    expect(parts.every(p => p.startsWith('/'))).toBe(true)
    expect(parts.slice(0, 2)).toEqual(['/usr/bin', '/b'])
  })

  it('HOME falls back to opts.home when the base has none', () => {
    expect(shellEnv({ PATH: '/usr/bin' }, { platform: 'linux', home: '/h' }).HOME).toBe('/h')
  })

  it('win32 keeps ComSpec, PATHEXT, SystemRoot (any key case) and the profile dirs; PATH untouched', () => {
    const base = {
      Path: 'C:\\Windows\\system32;C:\\tools',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      SYSTEMROOT: 'C:\\Windows',
      windir: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\u',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      TEMP: 'C:\\t',
      TMP: 'C:\\t',
      OPENAI_API_KEY: 'sk-x',
    }
    const env = shellEnv(base, { platform: 'win32', home: 'C:\\Users\\u', loginPath: '/ignored' })
    expect(env).toMatchObject({
      Path: 'C:\\Windows\\system32;C:\\tools',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      SYSTEMROOT: 'C:\\Windows',
      windir: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\u',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      TEMP: 'C:\\t',
      TMP: 'C:\\t',
      MFFAI: '1',
    })
    expect(env).not.toHaveProperty('OPENAI_API_KEY')
    expect(env).not.toHaveProperty('PATH')
    expect(env).not.toHaveProperty('HOME')
  })
})

describe('loginShellPath', () => {
  it('runs $SHELL -ilc and extracts PATH between markers (rc-file noise ignored)', async () => {
    const calls: { shell: string; args: string[]; timeoutMs: number }[] = []
    const exec = async (shell: string, args: string[], timeoutMs: number) => {
      calls.push({ shell, args, timeoutMs })
      const script = args[1]
      const marker = /'([^']*)%s/.exec(script)![1]
      return `welcome!\n${marker}/x/bin:/y/bin${marker}\nbye`
    }
    expect(await loginShellPath(exec, { SHELL: '/bin/zsh' }, 'darwin')).toBe('/x/bin:/y/bin')
    expect(calls).toHaveLength(1)
    expect(calls[0].shell).toBe('/bin/zsh')
    expect(calls[0].args[0]).toBe('-ilc')
    expect(calls[0].timeoutMs).toBe(3000)
  })

  it('memoised per exec: the probe runs once', async () => {
    let n = 0
    const exec = async (_s: string, args: string[]) => {
      n++
      const marker = /'([^']*)%s/.exec(args[1])![1]
      return `${marker}/p${marker}`
    }
    expect(await loginShellPath(exec, { SHELL: '/bin/sh' }, 'linux')).toBe('/p')
    expect(await loginShellPath(exec, { SHELL: '/bin/sh' }, 'linux')).toBe('/p')
    expect(n).toBe(1)
  })

  it("failure, missing markers, relative / missing SHELL, win32 → ''", async () => {
    expect(await loginShellPath(async () => { throw new Error('timeout') }, { SHELL: '/bin/sh' }, 'linux')).toBe('')
    expect(await loginShellPath(async () => 'no markers here', { SHELL: '/bin/sh' }, 'linux')).toBe('')
    let ran = false
    const spy = async () => { ran = true; return '' }
    expect(await loginShellPath(spy, { SHELL: 'zsh' }, 'linux')).toBe('')
    expect(await loginShellPath(spy, {}, 'linux')).toBe('')
    expect(await loginShellPath(spy, { SHELL: '/bin/sh' }, 'win32')).toBe('')
    expect(ran).toBe(false)
  })
})
