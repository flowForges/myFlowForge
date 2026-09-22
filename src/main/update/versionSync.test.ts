import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ★用户 2026-09-22 定的:**iOS / 安卓的版本号永远跟桌面端一致**(一起发、一起叫 1.2.3)。
 *  两个数字住在两个文件里(package.json / mobile/app.json),发版时漏改一个是迟早的事 —— 这里钉住。
 *  iOS 的构建号(buildNumber)是另一回事:每次上传 TestFlight 都要递增,不跟版本号走。
 */
describe('版本号', () => {
  it('手机端(mobile/app.json)和桌面端(package.json)是同一个版本号', () => {
    const root = join(__dirname, '../../..')
    const desktop = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
    const mobile = JSON.parse(readFileSync(join(root, 'mobile/app.json'), 'utf8')).expo.version
    expect(mobile).toBe(desktop)
  })
})
