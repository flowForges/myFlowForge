import { describe, it, expect } from 'vitest'
import { daemonEnv } from './spawn'

describe('daemonEnv', () => {
  it('keeps PATH/HOME/proxy, drops NODE_OPTIONS / ELECTRON_* / npm_*, forces ELECTRON_RUN_AS_NODE=1', () => {
    const base: NodeJS.ProcessEnv = {
      PATH: '/usr/bin', HOME: '/home/u', HTTPS_PROXY: 'http://p:1', http_proxy: 'http://p:2', NO_PROXY: 'localhost',
      NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '0', ELECTRON_ENABLE_LOGGING: '1', ELECTRON_ENABLE_STACK_DUMPING: '1',
      npm_config_prefix: '/x', npm_lifecycle_event: 'dev', NPM_CONFIG_USERCONFIG: '/y', MFFAI_DATA_DIR: '/old',
    }
    expect(daemonEnv(base, '/data')).toEqual({
      PATH: '/usr/bin', HOME: '/home/u', HTTPS_PROXY: 'http://p:1', http_proxy: 'http://p:2', NO_PROXY: 'localhost',
      ELECTRON_RUN_AS_NODE: '1', MFFAI_DATA_DIR: '/data', NODE_USE_ENV_PROXY: '1',
    })
    expect(base.NODE_OPTIONS).toBe('--inspect') // 不改原对象
  })
  it('appProxy 覆盖继承的代理并打开 NODE_USE_ENV_PROXY;无代理时不打开', () => {
    const env = daemonEnv({ PATH: '/b', NO_PROXY: 'corp' }, '/d', ' http://127.0.0.1:7897 ')
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) expect(env[k]).toBe('http://127.0.0.1:7897')
    expect(env.NO_PROXY).toBe('corp,localhost,127.0.0.1')
    expect(env.NODE_USE_ENV_PROXY).toBe('1')
    expect(daemonEnv({ PATH: '/b' }, '/d', '').NODE_USE_ENV_PROXY).toBeUndefined()
  })
})
