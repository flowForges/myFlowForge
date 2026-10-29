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
      ELECTRON_RUN_AS_NODE: '1', MFFAI_DATA_DIR: '/data',
    })
    expect(base.NODE_OPTIONS).toBe('--inspect') // 不改原对象
  })
})
