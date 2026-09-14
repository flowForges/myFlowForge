import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, copyFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const { signingPlan, isMachO, machOFilesUnder } = require('./macSigning.cjs')

/**
 * 这套分支的失败形态全是**假绿**:构建成功、产物也在、但用户那边打不开或者终端是坏的。
 * 本机打包没有 CI 兜底,所以判断逻辑必须钉死在这里。
 */
describe('signingPlan —— 该怎么签', () => {
  it('什么都不配 = ad-hoc（今天的默认，行为不能变）', () => {
    expect(signingPlan({})).toEqual({ mode: 'adhoc' })
  })

  it('只有空格也算没配 —— 别让一个手滑的 export 把构建带进"以为签了"', () => {
    expect(signingPlan({ APPLE_SIGN_IDENTITY: '   ' })).toEqual({ mode: 'adhoc' })
  })

  it('★★拿开发证书当分发证书 → 直接抛', () => {
    // 这台机器的钥匙串里就躺着一张 "Apple Development: …"，名字和分发证书长得很像。
    // 用它签出来的包：构建全绿、本机双击能开、**换台机器就打不开**，公证还会被苹果拒。
    expect(() => signingPlan({ APPLE_SIGN_IDENTITY: 'Apple Development: someone@example.com (K8265)' }))
      .toThrow(/不是分发证书/)
    // 上架用的 Apple Distribution 同样不行 —— 它签不了自己发的 dmg。
    expect(() => signingPlan({ APPLE_SIGN_IDENTITY: 'Apple Distribution: Somebody (T1)' }))
      .toThrow(/不是分发证书/)
  })

  it('40 位指纹形式的身份放行（codesign 也认这种写法）', () => {
    const hash = 'a'.repeat(40)
    expect(signingPlan({ APPLE_SIGN_IDENTITY: hash, FORGE_NOTARY_PROFILE: 'p' }).identity).toBe(hash)
  })

  it('★★配了证书却没配公证凭据 → 直接抛，不许静默出包', () => {
    // 签了不公证的包，用户下载后照样弹「无法验证开发者」——而构建是全绿的。
    // 这是整条链路上最容易骗过自己的一步，所以必须是**拦住**，不是警告。
    expect(() => signingPlan({ APPLE_SIGN_IDENTITY: 'Developer ID Application: X (T1)' }))
      .toThrow(/FORGE_NOTARY_PROFILE/)
  })

  it('抛出的话里要给出能照着敲的下一步，不能只说"没配"', () => {
    try {
      signingPlan({ APPLE_SIGN_IDENTITY: 'Developer ID Application: X (T1)' })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e.message).toContain('notarytool store-credentials')
      expect(e.message).toContain('FORGE_ALLOW_UNNOTARIZED=1')
    }
  })

  it('明确说了 FORGE_ALLOW_UNNOTARIZED=1 才放行（本地试签名用）', () => {
    expect(signingPlan({
      APPLE_SIGN_IDENTITY: 'Developer ID Application: X (T1)',
      FORGE_ALLOW_UNNOTARIZED: '1',
    })).toEqual({
      mode: 'developer-id', identity: 'Developer ID Application: X (T1)',
      notaryProfile: null, skipDmgNotarize: false,
    })
  })

  it('证书 + 公证凭据齐了 = 正式包', () => {
    expect(signingPlan({
      APPLE_SIGN_IDENTITY: 'Developer ID Application: zhu guohua (ABCDE12345)',
      FORGE_NOTARY_PROFILE: 'myflowforge-notary',
    })).toEqual({
      mode: 'developer-id',
      identity: 'Developer ID Application: zhu guohua (ABCDE12345)',
      notaryProfile: 'myflowforge-notary',
      skipDmgNotarize: false,
    })
  })

  it('dmg 公证默认**不**跳过 —— 用户下载的就是 dmg，跳过必须是显式的', () => {
    const base = { APPLE_SIGN_IDENTITY: 'Developer ID Application: X (T1)', FORGE_NOTARY_PROFILE: 'p' }
    expect(signingPlan(base).skipDmgNotarize).toBe(false)
    // 只有 '1' 算数，'true' / 'yes' 一律不认（免得以为跳过了其实没跳，或反过来）。
    expect(signingPlan({ ...base, FORGE_SKIP_DMG_NOTARIZE: 'true' }).skipDmgNotarize).toBe(false)
    expect(signingPlan({ ...base, FORGE_SKIP_DMG_NOTARIZE: '1' }).skipDmgNotarize).toBe(true)
  })
})

describe('machOFilesUnder —— 找出 electron-builder 会漏签的那些文件', () => {
  it('★认得出"没有后缀的可执行文件"，那正是 node-pty spawn-helper 的形态', () => {
    // 漏签它的后果：公证照样通过、包也打得开，**只有终端是坏的**。所以识别逻辑要钉住。
    const dir = mkdtempSync(join(tmpdir(), 'macho-'))
    try {
      mkdirSync(join(dir, 'prebuilds'))
      // /bin/ls 是货真价实的 Mach-O，拿它冒充 spawn-helper（同样没有后缀）。
      copyFileSync('/bin/ls', join(dir, 'prebuilds', 'spawn-helper'))
      writeFileSync(join(dir, 'package.json'), '{}')
      writeFileSync(join(dir, 'readme.txt'), 'not a binary')

      const found = machOFilesUnder(dir)
      expect(found).toEqual([join(dir, 'prebuilds', 'spawn-helper')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('isMachO 只看文件头，不看后缀也不看可执行位', () => {
    expect(isMachO('/bin/ls')).toBe(true)
    expect(isMachO('package.json')).toBe(false)
    expect(isMachO('/does/not/exist')).toBe(false)
  })
})
