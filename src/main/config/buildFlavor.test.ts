import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildTestFlag } from './sysDirName'

// 并排测试包(并排测试包):构建期 MFF_TEST_BUILD=1 → 不自更新、不登记 URL scheme、Windows 的 AppUserModelID 另起
const ROOT = join(__dirname, '..', '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('test build flavor', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

  it('unset: release behaviour — self-update on, the release AppUserModelID', async () => {
    expect(typeof (globalThis as Record<string, unknown>).__MFF_TEST_BUILD__).toBe('undefined')
    const f = await import('./buildFlavor')
    expect(f.IS_TEST_BUILD).toBe(false)
    expect(f.SELF_UPDATE_ENABLED).toBe(true)
    expect(f.APP_USER_MODEL_ID).toBe('com.zghua.myflowforge')
  })

  it('false (what the release build defines): same as unset', async () => {
    vi.stubGlobal('__MFF_TEST_BUILD__', false)
    vi.resetModules()
    const f = await import('./buildFlavor')
    expect(f.SELF_UPDATE_ENABLED).toBe(true)
    expect(f.APP_USER_MODEL_ID).toBe('com.zghua.myflowforge')
  })

  it('true: self-update off and a distinct AppUserModelID', async () => {
    vi.stubGlobal('__MFF_TEST_BUILD__', true)
    vi.resetModules()
    const f = await import('./buildFlavor')
    expect(f.IS_TEST_BUILD).toBe(true)
    expect(f.SELF_UPDATE_ENABLED).toBe(false)
    expect(f.APP_USER_MODEL_ID).toBe('com.zghua.myflowforge.test')
  })

  it('a non-boolean value is not a test build', async () => {
    vi.stubGlobal('__MFF_TEST_BUILD__', '1')
    vi.resetModules()
    expect((await import('./buildFlavor')).IS_TEST_BUILD).toBe(false)
  })

  it('buildTestFlag: unset/empty → false; 1 needs a valid MFF_SYS_DIR_NAME; anything else fails the build', () => {
    expect(buildTestFlag(undefined, undefined)).toBe(false)
    expect(buildTestFlag('', '.myFlowForge-test')).toBe(false)
    expect(buildTestFlag('1', '.myFlowForge-test')).toBe(true)
    expect(() => buildTestFlag('1', undefined)).toThrow(/MFF_SYS_DIR_NAME/)
    expect(() => buildTestFlag('1', '')).toThrow(/MFF_SYS_DIR_NAME/)
    for (const bad of ['0', 'true', 'yes', ' 1']) expect(() => buildTestFlag(bad, '.myFlowForge-test'), bad).toThrow(/MFF_TEST_BUILD/)
  })

  it('electron.vite.config.ts defines __MFF_TEST_BUILD__ for main only, through buildTestFlag', () => {
    const cfg = read('electron.vite.config.ts')
    expect(cfg.match(/__MFF_TEST_BUILD__/g)?.length).toBe(1)
    const main = cfg.slice(cfg.indexOf('main: {'), cfg.indexOf('preload: {'))
    expect(main).toMatch(/__MFF_TEST_BUILD__: JSON\.stringify\(buildTestFlag\(process\.env\.MFF_TEST_BUILD, process\.env\.MFF_SYS_DIR_NAME\)\)/)
  })

  it('handlers gate the update checker on SELF_UPDATE_ENABLED: no timer, no GitHub fetch, no download', () => {
    const src = read('src/main/ipc/handlers.ts')
    expect(src).toMatch(/import \{ SELF_UPDATE_ENABLED \} from '\.\.\/config\/buildFlavor'/)
    const block = src.slice(src.indexOf('const updateChecker = createUpdateChecker({'), src.indexOf('const listBusy'))
    expect(block).toMatch(/fetchLatest: \(r\) => SELF_UPDATE_ENABLED \? fetchLatestRelease\(/)
    expect(block).toMatch(/: Promise\.resolve\(null\)/)
    expect(block).toMatch(/if \(SELF_UPDATE_ENABLED\) updateChecker\.start\(\)/)
    expect(block).not.toMatch(/^\s*updateChecker\.start\(\)/m)
  })

  it('index.ts takes the AppUserModelID from buildFlavor', () => {
    const src = read('src/main/index.ts')
    expect(src).toContain('app.setAppUserModelId(APP_USER_MODEL_ID)')
    expect(src).not.toMatch(/setAppUserModelId\('/)
  })

  it('no URL scheme registration anywhere: main never calls setAsDefaultProtocolClient / open-url, the builder config has no protocols', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of require('node:fs').readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`
        if (e.isDirectory()) walk(p)
        else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
          const s = read(p)
          if (/setAsDefaultProtocolClient|['"]open-url['"]/.test(s)) offenders.push(p)
        }
      }
    }
    walk('src/main')
    expect(offenders).toEqual([])
    expect(read('electron-builder.yml')).not.toMatch(/^\s*protocols:/m)
    expect(read('scripts/build-mac-test.sh')).not.toMatch(/protocols/)
  })

  it('dist:mac-test: test name/id/dir, host arch only, ad-hoc, its own output dir; the release scripts are untouched', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.scripts['dist:mac-test']).toBe('bash scripts/build-mac-test.sh')
    expect(pkg.scripts.dist).toBe('npm run dist:mac-all')
    const sh = read('scripts/build-mac-test.sh')
    expect(sh).toContain('export MFF_TEST_BUILD=1')
    expect(sh).toContain('export MFF_SYS_DIR_NAME=.myFlowForge-test')
    expect(sh).toContain('-c.productName="myFlowForge Test"')
    expect(sh).toContain('-c.extraMetadata.productName="myFlowForge Test"')
    expect(sh).toContain('-c.appId=com.zghua.myflowforge.test')
    expect(sh).toContain('-c.directories.output=release-test')
    expect(sh).toMatch(/unset APPLE_SIGN_IDENTITY/)
    // 签名配置只在显式 MFF_TEST_SIGN=1 时读;默认仍是 ad-hoc
    const signBlock = sh.slice(sh.indexOf('if [ "${MFF_TEST_SIGN:-}" = 1 ]'), sh.indexOf('\nfi\n', sh.indexOf('if [ "${MFF_TEST_SIGN:-}" = 1 ]')))
    expect(signBlock).toContain('.signing.local.sh')
    expect(sh.replace(signBlock, '')).not.toContain('.signing.local.sh')
    expect(read('scripts/build-mac-all.sh')).not.toMatch(/MFF_TEST_BUILD|MFF_SYS_DIR_NAME/)
    expect(read('scripts/build-mac-all.sh')).not.toMatch(/myflowforge\.test/)
  })
})
