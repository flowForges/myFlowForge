import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { aboutRows } from './aboutRows'

describe('「关于」那一屏摆什么', () => {
  it('连着的时候三行都是真数', () => {
    const rows = aboutRows({ clientVersion: '1.2.0', host: { version: '1.2.3', methods: 139 } })
    expect(rows.map((r) => r.label)).toEqual(['手机端版本', '主机版本', '主机提供的方法'])
    expect(rows.map((r) => r.value)).toEqual(['1.2.0', '1.2.3', '139 个'])
    expect(rows.map((r) => r.known)).toEqual([true, true, true])
  })

  it('★断着的时候对面那两行写「连上才知道」,绝不留上一次的旧值', () => {
    const rows = aboutRows({ clientVersion: '1.2.0', host: null })
    expect(rows.map((r) => r.value)).toEqual(['1.2.0', '连上才知道', '连上才知道'])
    // known=false 是给调用方画淡用的:占位文字不该和真数据一样重。
    expect(rows.map((r) => r.known)).toEqual([true, false, false])
  })

  it('★手机端版本原样来自调用方 —— 这里写死一个版本号的话,界面和握手报的会对不上', () => {
    // 取一个绝不可能被写死在源码里的串:函数里但凡有一处硬编码,这条就红。
    const rows = aboutRows({ clientVersion: '0.0.0-from-app-json', host: null })
    expect(rows[0].value).toBe('0.0.0-from-app-json')
  })

  it('方法数是 0 也照样是真数(「连上了但一个方法都没有」和「没连上」是两回事)', () => {
    const rows = aboutRows({ clientVersion: '1.2.0', host: { version: '1.2.0', methods: 0 } })
    expect(rows[2]).toEqual({ label: '主机提供的方法', value: '0 个', known: true })
  })
})

/**
 * ★源码守卫:那一屏必须从 `CLIENT_VERSION`(→ `app.json`)取版本,不许自己抄一个数进去。
 *  ★文件不在就**判红**,不是跳过 —— 按路径找文件的守卫最容易被一次改名静默架空,
 *   本仓库栽过(见 `storageKeys.test.ts` 顶上的注释)。改名了就来改这条,别让它悄悄失效。
 */
const ABOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app/about.tsx')

describe('关于屏的版本号来源', () => {
  it('★这一屏还在(改名了就来改这条守卫,别让它变成永远绿的)', () => {
    expect(fs.existsSync(ABOUT)).toBe(true)
  })

  it('★★用的是 CLIENT_VERSION,而且整份源码里没有一个写死的版本号', () => {
    const src = fs.readFileSync(ABOUT, 'utf8')
    expect(src).toContain('CLIENT_VERSION')
    // 形如 1.2.0 的东西一律不许出现在这一屏(注释里也不行 —— 注释里的版本号一样会过期骗人)。
    expect(src.match(/\d+\.\d+\.\d+/)).toBe(null)
  })
})
