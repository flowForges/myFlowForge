// 没有说明文字(08 §6.4、评审修订 R6)和渲染层只按类型引用裸协议包(R14)的源码守卫。
// 每条规则都有一行"在临时副本里种一个违规,扫描要失败"。
import { describe, it, expect, afterEach } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ALLOWLIST, LEGACY, listSources, scanHintText, scanProtocolImports, scanTree, type Rule } from './test/scan'

const MFFAI = resolve(__dirname)
const RENDERER = resolve(__dirname, '..')

let tmp: string | undefined
afterEach(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = undefined })

/** 把 src/renderer/mffai 复制到临时目录,种一个文件,扫一遍 */
function plant(name: string, text: string, scan = scanHintText) {
  tmp = mkdtempSync(join(tmpdir(), 'mffai-scan-'))
  cpSync(MFFAI, tmp, { recursive: true })
  mkdirSync(dirname(join(tmp, name)), { recursive: true })
  writeFileSync(join(tmp, name), text)
  return scanTree(tmp, scan)
}
const rulesFor = (vs: ReturnType<typeof plant>, file: string) => vs.filter((v) => v.file === file).map((v) => v.rule)

describe('no explanatory text under src/renderer/mffai', () => {
  it('scans .ts and .tsx, skips tests and test/', () => {
    const files = listSources(MFFAI)
    expect(files).toContain('labels.ts')
    expect(files).toContain('MffaiView.tsx')
    expect(files).toContain('ui/Confirm.tsx')
    expect(files.some((f) => f.includes('.test.'))).toBe(false)
    expect(files.some((f) => f.startsWith('test/'))).toBe(false)
  })

  it('the real tree is clean', () => {
    expect(scanTree(MFFAI, scanHintText)).toEqual([])
  })

  it('the allowlist is the two spec §16 labels, and the legacy exemption is one placeholder', () => {
    expect(ALLOWLIST).toHaveLength(2)
    expect(LEGACY).toEqual([{ file: 'DebugPanel.tsx', rule: 'placeholder', text: '工作目录' }])
  })

  const rows: [string, string, string, Rule][] = [
    ['a 15-character literal', 'Plant.tsx', `export const x = '${'一二三四五六七八九十一二三四五'}'\n`, 'cjk-length'],
    ['a 6-character literal ending in 。', 'Plant.tsx', `export const x = '一二三四五。'\n`, 'punctuation'],
    ['a literal in a .ts file', 'plant.ts', `export const L = { a: '${'一二三四五六七八九十一二三四五'}' }\n`, 'cjk-length'],
    ['a template literal static part', 'plant.ts', 'export const f = (n: number) => `一二三四五六七八${n}九十一二三四五六七`\n', 'cjk-length'],
    ['JSX text split by {x} into two 8-character halves', 'Plant.tsx', `export const C = ({ x }: { x: string }) => <span>一二三四五六七八{x}一二三四五六七八</span>\n`, 'cjk-length'],
    ['a CJK placeholder', 'Plant.tsx', `export const C = () => <input placeholder="请输入" />\n`, 'placeholder'],
    ['a CJK placeholder in an expression', 'Plant.tsx', `export const C = () => <input placeholder={'路径'} />\n`, 'placeholder'],
    ['a dangerouslySetInnerHTML', 'Plant.tsx', `export const C = ({ h }: { h: string }) => <div dangerouslySetInnerHTML={{ __html: h }} />\n`, 'dangerouslySetInnerHTML'],
    ['a dangerouslySetInnerHTML via spread props', 'plant.ts', `export const p = { dangerouslySetInnerHTML: { __html: '' } }\n`, 'dangerouslySetInnerHTML'],
    ['，in a short literal', 'plant.ts', `export const x = '好，'\n`, 'punctuation'],
    ['a nested folder', 'deep/Plant.tsx', `export const x = '${'一二三四五六七八九十一二三四五'}'\n`, 'cjk-length'],
  ]
  for (const [what, file, text, rule] of rows) {
    it(`fails on ${what}`, () => {
      expect(rulesFor(plant(file, text), file)).toContain(rule)
    })
  }

  it('passes a 14-character literal, an ASCII placeholder, the allowlist and the legacy placeholder only in DebugPanel', () => {
    const ok = [
      `export const x = '一二三四五六七八九十一二三四'`,
      `export const C = () => <input placeholder="https://" />`,
      `export const A = '${ALLOWLIST[0]}'`,
      `export const C = () => <label>{'${ALLOWLIST[1]}'}</label>`,
    ].join('\n')
    expect(scanHintText('Ok.tsx', ok)).toEqual([])
    expect(scanHintText('DebugPanel.tsx', `export const C = () => <input placeholder="工作目录" />`)).toEqual([])
    expect(scanHintText('Other.tsx', `export const C = () => <input placeholder="工作目录" />`).map((v) => v.rule)).toEqual(['placeholder'])
  })

  it('a test file and test/ are not scanned', () => {
    tmp = mkdtempSync(join(tmpdir(), 'mffai-scan-'))
    cpSync(MFFAI, tmp, { recursive: true })
    writeFileSync(join(tmp, 'X.test.tsx'), `export const x = '一二三四五。'`)
    writeFileSync(join(tmp, 'test', 'x.ts'), `export const x = '一二三四五。'`)
    expect(scanTree(tmp, scanHintText)).toEqual([])
  })
})

describe('renderer value imports come only from @mffai/protocol/browser', () => {
  it('the real src/renderer is clean', () => {
    expect(scanTree(RENDERER, scanProtocolImports)).toEqual([])
  })

  const bad: [string, string][] = [
    ['a value import', `import { KernelEventSchema } from '@mffai/protocol'`],
    ['an inline-type-only import (still a value import statement)', `import { type KernelEvent } from '@mffai/protocol'`],
    ['a side-effect import', `import '@mffai/protocol'`],
    ['a namespace import', `import * as P from '@mffai/protocol'`],
    ['a value re-export', `export { ERR_BUSY } from '@mffai/protocol'`],
    ['a dynamic import', `export const p = () => import('@mffai/protocol')`],
  ]
  for (const [what, text] of bad) {
    it(`fails on ${what}`, () => {
      expect(rulesFor(plant('plant.ts', text + '\n', scanProtocolImports), 'plant.ts')).toEqual(['protocol-value-import'])
    })
  }

  it('passes import type, export type, type-position import() and the browser entry', () => {
    const ok = [
      `import type { KernelEvent } from '@mffai/protocol'`,
      `export type { MffaiState } from '@mffai/protocol'`,
      `import { KernelEventSchema } from '@mffai/protocol/browser'`,
      `export type X = import('@mffai/protocol').KernelEvent`,
    ].join('\n')
    expect(scanProtocolImports('ok.ts', ok)).toEqual([])
  })
})
