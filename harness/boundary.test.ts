import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { codeFiles, importsOf, scanSource, scanTree, stringsOf, type Finding } from './test/codeScan'

const REPO = resolve(__dirname, '..')
const HARNESS_SRC = join(REPO, 'harness', 'src')
const APP_SRC = join(REPO, 'src')
const PLUGINS = join(HARNESS_SRC, 'plugins')
const LIB = join(HARNESS_SRC, 'lib')
const KERNEL = join(HARNESS_SRC, 'kernel')

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p)
  }
  return out
}

/** 取出文件里所有 import/export-from/动态 import/require 的说明符。 */
function specifiers(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const out: string[] = []
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) out.push(m[1])
  return out
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + sep)
const resolved = (file: string, spec: string) => resolve(dirname(file), spec)

describe('harness 边界', () => {
  it('harness 不 import src/**', () => {
    const bad: string[] = []
    for (const f of walk(HARNESS_SRC))
      for (const s of specifiers(f)) {
        if (s.startsWith('@shared')) bad.push(`${relative(REPO, f)} -> ${s}`)
        else if (s.startsWith('.') && inside(resolved(f, s), APP_SRC)) bad.push(`${relative(REPO, f)} -> ${s}`)
      }
    expect(bad).toEqual([])
  })

  it('app 只经 @mffai/protocol 引用 harness', () => {
    const bad: string[] = []
    for (const f of walk(APP_SRC))
      for (const s of specifiers(f))
        if ((s.includes('harness/') || s.includes('@mffai/')) && s !== '@mffai/protocol') bad.push(`${relative(REPO, f)} -> ${s}`)
    expect(bad).toEqual([])
  })

  it('插件之间不互相 import', () => {
    const bad: string[] = []
    for (const f of walk(PLUGINS)) {
      const parts = relative(PLUGINS, f).split(sep)
      if (parts.length === 1 && parts[0] === 'index.ts') continue // 静态登记表,允许引用各插件
      const own = parts[0]
      for (const s of specifiers(f)) {
        if (!s.startsWith('.')) continue
        const r = resolved(f, s)
        if (!inside(r, PLUGINS)) continue
        const other = relative(PLUGINS, r).split(sep)[0]
        if (other !== own) bad.push(`${relative(REPO, f)} -> ${s}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('lib 是纯库:不 import kernel/** 或 plugins/**', () => {
    const files = walk(LIB)
    expect(files.length).toBeGreaterThan(0)
    const bad: string[] = []
    for (const f of files)
      for (const s of specifiers(f)) {
        if (!s.startsWith('.')) continue
        const r = resolved(f, s)
        if (inside(r, KERNEL) || inside(r, PLUGINS)) bad.push(`${relative(REPO, f)} -> ${s}`)
      }
    expect(bad).toEqual([])
  })

  it('kernel 不 import plugins/**(插件由 entry 登记)', () => {
    const files = walk(KERNEL)
    expect(files.length).toBeGreaterThan(0)
    const bad: string[] = []
    for (const f of files)
      for (const s of specifiers(f)) if (s.startsWith('.') && inside(resolved(f, s), PLUGINS)) bad.push(`${relative(REPO, f)} -> ${s}`)
    expect(bad).toEqual([])
  })

  it('src/main/mffai 不 import electron,index.ts 只动态 import mffai/host', () => {
    const bad: string[] = []
    for (const f of walk(join(APP_SRC, 'main', 'mffai')))
      for (const s of specifiers(f)) if (s === 'electron' || s.startsWith('electron/')) bad.push(`${relative(REPO, f)} -> ${s}`)
    expect(bad).toEqual([])

    const idx = join(APP_SRC, 'main', 'index.ts')
    const text = existsSync(idx) ? readFileSync(idx, 'utf8') : ''
    expect(text).not.toMatch(/^\s*(?:import|export)\b[^;(]*?\bfrom\s*['"]\.\/mffai\/host['"]/m)
    expect(text).not.toMatch(/^\s*import\s*['"]\.\/mffai\/host['"]/m)
  })
})

/** 树里每一处都要有这里的一行:多一处、少一处都算失败,不会有悄悄放行的。理由写在行上 */
const EXPLAINED: { file: string; kind: string; count: number; why: string }[] = [
  { file: 'entry/devPlugins.ts', kind: 'dynamic-import', count: 1, why: 'the only loader: an approved copy, after its hash check' },
  { file: 'entry/daemon.ts', kind: 'require', count: 2, why: '`typeof require` and `require.main === module` ask whether the bundle is the entry; nothing is loaded' },
  { file: 'plugins/tools-coding/grepWorker.ts', kind: 'forbidden-module', count: 1, why: 'node:worker_threads: the model-supplied regex must be killable, so grep runs on its own thread' },
  { file: 'plugins/tools-coding/grepWorker.ts', kind: 'worker', count: 1, why: 'runs GREP_WORKER_SOURCE only; pinned below' },
  { file: 'plugins/tools-coding/grepWorker.ts', kind: 'eval', count: 1, why: '`eval: true` is the Worker option for that constant source; the regex and files travel as workerData' },
  { file: 'lib/sandbox/bwrap.ts', kind: 'node-eval-flag', count: 1, why: 'relay in a sandboxed child, not in the worker: constant RELAY_SOURCE; pinned below' },
]

/** 没解释的,和解释了却不在树里的 */
function unexplained(findings: Finding[]): string[] {
  const seen = new Map<string, Finding[]>()
  for (const f of findings) {
    const k = `${f.file} ${f.kind}`
    seen.set(k, [...(seen.get(k) ?? []), f])
  }
  const out: string[] = []
  for (const e of EXPLAINED) {
    const k = `${e.file} ${e.kind}`
    const n = seen.get(k)?.length ?? 0
    if (n !== e.count) out.push(`${k}: ${n}, explained ${e.count}${n > 0 ? ` (${seen.get(k)!.map(f => `:${f.line}`).join(' ')})` : ''}`)
    seen.delete(k)
  }
  for (const fs of seen.values()) for (const f of fs) out.push(`${f.file}:${f.line} ${f.kind}: ${f.text}`)
  return out
}

/** spec §12 第 2 条,以及谁能碰 devPlugins、谁能说出 plugins.dev.* */
function layerFindings(root: string): string[] {
  const out: string[] = []
  const devNamers = new Set(['protocol/rpc.ts', 'protocol/events.ts', 'plugins/plugin-manager/index.ts', 'entry/devPlugins.ts'])
  for (const { abs, rel, link, native } of codeFiles(root)) {
    if (link || native) continue // scanTree 已经报了
    const text = readFileSync(abs, 'utf8')
    const specs = importsOf(text, rel)
    const toEntry = (s: string) => s.startsWith('.') && resolve('/', dirname(rel), s).startsWith('/entry/')
    const isDevLoader = (s: string) => s.startsWith('.') && resolve('/', dirname(rel), s) === '/entry/devPlugins'
    if (/^(?:plugins\/plugin-manager|lib\/plugins)\//.test(rel)) for (const s of specs) if (toEntry(s)) out.push(`${rel} -> ${s}`)
    if (/^lib\/(?:plugins|mcp)\//.test(rel) && rel !== 'lib/plugins/fetchGit.ts') {
      for (const s of specs) if (s === 'child_process' || s === 'node:child_process') out.push(`${rel} -> ${s}`)
    }
    if (rel !== 'entry/worker.ts') for (const s of specs) if (isDevLoader(s)) out.push(`${rel} -> ${s}`)
    if (!devNamers.has(rel)) for (const s of stringsOf(text, rel)) if (s.includes('plugins.dev')) out.push(`${rel} names ${s}`)
  }
  return out
}

describe('动态代码:只有 entry/devPlugins.ts 能载代码', () => {
  const kinds = (text: string, file = 'x.ts') => scanSource(text, file).map(f => f.kind)

  it.each([
    // 动态 import
    ['import(x)', 'dynamic-import'],
    ['import(`./${x}`)', 'dynamic-import'],
    ["import('./a' + b)", 'dynamic-import'],
    ["import('./a' + './b')", 'dynamic-import'],
    ['const i = (u: string) => import(u)', 'dynamic-import'],
    ["import('data:text/javascript,1')", 'code-url'],
    ["import x from 'data:text/javascript,1'", 'code-url'],
    ["import('https://example.invalid/x.mjs')", 'code-url'],
    // require
    ['require(x)', 'require'],
    ['require(`./${x}`)', 'require'],
    ["require('./a' + b)", 'require'],
    ['const r = require', 'require'],
    ['(require)(x)', 'require'],
    ['require?.(x)', 'require'],
    ['module.require(x)', 'require'],
    ['require.main.require(x)', 'require'],
    ['process.mainModule.require(x)', 'require'],
    ['const { require: r } = module', 'require'],
    ["module['require'](x)", 'require'],
    ['require.call(null, x)', 'require'],
    // eval
    ['eval(x)', 'eval'],
    ['(0, eval)(x)', 'eval'],
    ['globalThis.eval(x)', 'eval'],
    ['global.eval(x)', 'eval'],
    ["globalThis['eval'](x)", 'eval'],
    ['globalThis[`eval`](x)', 'eval'],
    ['const e = eval', 'eval'],
    ['const { eval: e } = globalThis', 'eval'],
    ["const { 'eval': e } = globalThis", 'eval'],
    ['ev\\u0061l(x)', 'eval'],
    ["Reflect.get(globalThis, 'eval')", 'eval'],
    ['new Worker(src, { eval: true })', 'eval'],
    ["new Worker(src, { 'eval': true })", 'eval'],
    // Function 和它的几种取法
    ['new Function(x)', 'function-constructor'],
    ["new Function('return 1')", 'function-constructor'],
    ['Function(x)', 'function-constructor'],
    ['globalThis.Function(x)', 'function-constructor'],
    ['const F = Function', 'function-constructor'],
    ['Reflect.construct(Function, [x])', 'function-constructor'],
    ['(() => {}).constructor(x)', 'function-constructor'],
    ["(() => {})['constructor'](x)", 'function-constructor'],
    ['new (async function () {}).constructor(x)', 'function-constructor'],
    ['const F = f.constructor', 'function-constructor'],
    ['const { constructor: F } = f', 'function-constructor'],
    ["Reflect.get(f, 'constructor')", 'function-constructor'],
    ['Object.getPrototypeOf(async function () {}).constructor(x)', 'function-constructor'],
    ['new AsyncFunction(x)', 'function-constructor'],
    ['new GeneratorFunction(x)', 'function-constructor'],
    // 模块
    ["import vm from 'node:vm'", 'forbidden-module'],
    ["import vm from 'vm'", 'forbidden-module'],
    ["import * as vm from 'node:vm'", 'forbidden-module'],
    ["import { runInThisContext as r } from 'vm'", 'forbidden-module'],
    ["import 'node:vm'", 'forbidden-module'],
    ["import vm = require('node:vm')", 'forbidden-module'],
    ["export { Script } from 'node:vm'", 'forbidden-module'],
    ["export * from 'vm'", 'forbidden-module'],
    ["import('node:vm')", 'forbidden-module'],
    ["import(`vm`)", 'forbidden-module'],
    ["require('node:vm')", 'forbidden-module'],
    ["import x from 'node:\\u0076m'", 'forbidden-module'],
    ["import m from 'module'", 'forbidden-module'],
    ["import m from 'node:module'", 'forbidden-module'],
    ["import * as m from 'module'", 'forbidden-module'],
    ["const m = require('module')", 'forbidden-module'],
    ["import('node:module')", 'forbidden-module'],
    ["import { Worker } from 'node:worker_threads'", 'forbidden-module'],
    ["import { Worker } from 'worker_threads'", 'forbidden-module'],
    ["import r from 'node:repl'", 'forbidden-module'],
    ["import i from 'node:inspector'", 'forbidden-module'],
    ["import w from 'node:wasi'", 'forbidden-module'],
    // createRequire、原生模块、加载器内部
    ['createRequire(x)', 'create-require'],
    ['const r = m.createRequire(x)', 'create-require'],
    ["m['createRequire'](x)", 'create-require'],
    ["import { createRequire } from 'somewhere'", 'create-require'],
    ['process.dlopen(m, x)', 'dlopen'],
    ["process['dlopen'](m, x)", 'dlopen'],
    ['const { dlopen } = process', 'dlopen'],
    ["import { dlopen } from 'node:process'", 'dlopen'],
    ["Reflect.get(process, 'dlopen')", 'dlopen'],
    ["process['dl' + 'open'](m, x)", 'global-alias'],
    ['process[k](m, x)', 'global-alias'],
    ['globalThis[k](x)', 'global-alias'],
    ['global[k](x)', 'global-alias'],
    ['const g = globalThis', 'global-alias'],
    ['const g = global', 'global-alias'],
    ['f(globalThis)', 'global-alias'],
    ["process.getBuiltinModule('node:vm')", 'loader-internal'],
    ["process.binding('contextify')", 'loader-internal'],
    ["process['binding']('contextify')", 'loader-internal'],
    ["process._linkedBinding('x')", 'loader-internal'],
    ['Module._load(x)', 'loader-internal'],
    ['m._compile(x, y)', 'loader-internal'],
    ['WebAssembly.instantiate(x)', 'loader-internal'],
    ['new ShadowRealm()', 'loader-internal'],
    // Worker、把测试文件当产品代码载、给子进程的 node 递代码
    ['new Worker(src)', 'worker'],
    ['new w.Worker(src)', 'worker'],
    ["import x from './a.test'", 'imports-test-file'],
    ["import('./a.test.ts')", 'imports-test-file'],
    ["spawn(node, ['-e', src])", 'node-eval-flag'],
    ["spawn(node, ['--eval', src])", 'node-eval-flag'],
    ["spawn(node, ['--import', x])", 'node-eval-flag'],
    ["spawn(node, ['--require', x])", 'node-eval-flag'],
  ])('flags %s', (code, kind) => {
    expect(kinds(code)).toContain(kind)
  })

  it.each([
    ["import('./literal')"],
    ['import(`./literal`)'],
    ["require('./literal')"],
    ['require(`./literal`)'],
    ["import { spawn } from 'node:child_process'"],
    ['// eval(x) new Function(x) import(x) node:vm'],
    ['/* require(x) */ const a = 1'],
    ["const s = 'eval(x) new Function(x) createRequire process.dlopen'"],
    ["const keys = new Set(['__proto__', 'constructor', 'prototype'])"],
    ['const evaluate = 1, required = 2, requireAbsolute = 3, retrieval = 4'],
    ['class A { constructor(readonly x: number) {} }'],
    ['let f: Function | undefined'],
    ['interface Opts { eval: boolean; constructor: unknown; require: string }'],
    ['type T = { eval: boolean }'],
    ["type T = typeof import('node:vm')"],
    ['globalThis.fetch(x)'],
    ['if (typeof f === "function") f()'],
    ['process.platform; process.env[k]; process.exit(0)'],
    ['const o = { binding: 1 }; o.binding; const binding = 2'],
    ["spawn('git', ['-c', x, '-p'])"],
  ])('leaves %s alone', code => {
    expect(scanSource(code)).toEqual([])
  })

  it('a file that does not parse counts, so bad syntax hides nothing', () => {
    expect(kinds('const = ;;; ((( eval(x')).toContain('unparseable')
  })

  it('findings say where: the line and the source text', () => {
    expect(scanSource("const a = 1\nconst b = 2\neval(a + b)\n", 'a/b.ts')).toEqual([{ file: 'a/b.ts', kind: 'eval', line: 3, text: 'eval' }])
  })

  it('the real tree holds only what EXPLAINED says, and it really scanned the tree', () => {
    const findings = scanTree(HARNESS_SRC)
    expect(unexplained(findings)).toEqual([])
    expect(findings.filter(f => f.kind === 'dynamic-import').map(f => f.file)).toEqual(['entry/devPlugins.ts'])
    expect(walk(HARNESS_SRC).length).toBeGreaterThan(200)
  })

  it('every explained source is a constant, and the Worker and relay run nothing else', () => {
    const grep = readFileSync(join(HARNESS_SRC, 'plugins/tools-coding/grepWorker.ts'), 'utf8')
    expect(grep).toMatch(/new Worker\(GREP_WORKER_SOURCE, \{/)
    const worker = /export const GREP_WORKER_SOURCE = `([^`]*)`/.exec(grep)
    expect(worker).not.toBeNull()
    expect(worker![1]).not.toContain('${') // 没有插值:模型的正则走 workerData
    // 字符串骗得过语法树,所以把内联源码也扫一遍:线程自己要 worker_threads,除此之外什么都不许
    expect(scanSource(worker![1], 'grep-worker-source.js').map(f => `${f.kind} ${f.text}`)).toEqual(['forbidden-module node:worker_threads'])

    const bwrap = readFileSync(join(HARNESS_SRC, 'lib/sandbox/bwrap.ts'), 'utf8')
    expect(bwrap.match(/'-e'/g)).toHaveLength(1)
    expect(bwrap).toMatch(/out\.push\(execPath, '-e', RELAY_SOURCE,/)
    const relay = readFileSync(join(HARNESS_SRC, 'lib/sandbox/relay.ts'), 'utf8')
    const source = /export const RELAY_SOURCE = String\.raw`([^`]*)`/.exec(relay)
    expect(source).not.toBeNull()
    // 插值只有两个常量:退出码和要删的环境变量名单
    const holes = [...new Set(source![1].match(/\$\{[^}]*\}/g))]
    expect(holes).toEqual(['${RELAY_FAILED}', "${RELAY_STRIP_ENV.map(k => JSON.stringify(k)).join(', ')}"])
    expect(relay).toMatch(/export const RELAY_FAILED = 125\n/)
    expect(relay).toMatch(/export const RELAY_STRIP_ENV = \[[^\]]*\] as const\n/)
    expect(scanSource(holes.reduce((t, h) => t.replaceAll(h, '0'), source![1]), 'relay-source.js')).toEqual([])
  })

  it('nothing but the worker imports devPlugins; the layers of spec §12 hold', () => {
    expect(layerFindings(HARNESS_SRC)).toEqual([])
    const worker = readFileSync(join(HARNESS_SRC, 'entry/worker.ts'), 'utf8')
    expect(importsOf(worker, 'entry/worker.ts')).toContain('./devPlugins')
  })

  describe('in a temp copy of what the scanner reads', () => {
    let copy = ''
    beforeAll(() => {
      copy = mkdtempSync(join(tmpdir(), 'mffai-boundary-'))
      cpSync(HARNESS_SRC, copy, { recursive: true, filter: s => !/\.test\.tsx?$/.test(s) })
    })
    afterAll(() => rmSync(copy, { recursive: true, force: true }))
    /** 种一个文件、看一遍、拿掉 */
    const planted = <T,>(rel: string, text: string, see: () => T): T => {
      const file = join(copy, rel)
      const before = existsSync(file) ? readFileSync(file, 'utf8') : undefined
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text)
      try {
        return see()
      } finally {
        if (before === undefined) rmSync(file)
        else writeFileSync(file, before)
      }
    }

    it('the copy starts clean', () => {
      expect(unexplained(scanTree(copy))).toEqual([])
      expect(layerFindings(copy)).toEqual([])
    })

    it.each([
      ['lib/util/a.ts', 'export const load = (x: string) => import(x)', 'dynamic-import'],
      ['plugins/loop-default/b.ts', 'export const f = (x: string) => new Function(x)', 'function-constructor'],
      ['kernel/deep/down/c.ts', "import vm from 'node:vm'\nexport default vm", 'forbidden-module'],
      ['entry/d.ts', "import { createRequire } from 'node:module'\nexport const r = createRequire('/')", 'forbidden-module'],
      ['plugins/plugin-manager/e.ts', 'export const f = (x: string) => process.dlopen({ exports: {} }, x)', 'dlopen'],
      ['lib/plugins/f.ts', 'export const f = (x: string) => require(x)', 'require'],
      ['protocol/g.ts', 'export const f = (x: string) => globalThis.eval(x)', 'eval'],
      ['entry/h.ts', 'export const f = (x: string) => (() => {}).constructor(x)', 'function-constructor'],
      ['entry/i.ts', "import * as m from 'module'\nexport default m", 'forbidden-module'],
      ['entry/j.tsx', 'export const f = (x: string) => import(x)', 'dynamic-import'],
      ['entry/k.mts', 'export const f = (x: string) => import(x)', 'dynamic-import'],
      ['entry/l.cts', 'export const f = (x: string) => import(x)', 'dynamic-import'],
      ['entry/m.mjs', 'export const f = x => import(x)', 'dynamic-import'],
      ['entry/n.cjs', 'module.exports = x => require(x)', 'require'],
      ['entry/o.js', 'module.exports = x => eval(x)', 'eval'],
      ['entry/p.jsx', 'module.exports = x => eval(x)', 'eval'],
      ['entry/addon.node', 'binary', 'native-file'],
      ['entry/addon.wasm', 'binary', 'native-file'],
    ])('planted %s is flagged', (rel, text, kind) => {
      const found = planted(rel, text, () => scanTree(copy))
      expect(found.filter(f => f.file === rel).map(f => f.kind)).toContain(kind)
      expect(unexplained(found).join('\n')).toContain(rel)
    })

    it("devPlugins.ts doesn't get a free pass: a second import or anything else in it fails", () => {
      const rel = 'entry/devPlugins.ts'
      const text = readFileSync(join(copy, rel), 'utf8')
      expect(planted(rel, `${text}\nexport const again = (x: string) => import(x)\n`, () => unexplained(scanTree(copy))).join('\n')).toContain('dynamic-import')
      expect(planted(rel, `${text}\nexport const f = (x: string) => new Function(x)\n`, () => unexplained(scanTree(copy))).join('\n')).toContain('function-constructor')
    })

    it('an explained hit gone from the tree is a failure too: the table cannot go stale', () => {
      const rel = 'entry/devPlugins.ts'
      expect(planted(rel, 'export {}\n', () => unexplained(scanTree(copy))).join('\n')).toContain('entry/devPlugins.ts dynamic-import: 0, explained 1')
    })

    it('a second eval worker beside the explained one fails on the count', () => {
      const rel = 'plugins/tools-coding/grepWorker.ts'
      const text = readFileSync(join(copy, rel), 'utf8')
      expect(planted(rel, `${text}\nexport const w = (s: string) => new Worker(s, { eval: true })\n`, () => unexplained(scanTree(copy))).join('\n')).toContain('explained 1')
    })

    it("test files aren't read, but a file that imports one is flagged, and a link in the tree is too", () => {
      expect(planted('entry/q.test.ts', 'eval(x)', () => unexplained(scanTree(copy)))).toEqual([])
      expect(planted('entry/r.ts', "export * from './q.test'", () => unexplained(scanTree(copy))).join('\n')).toContain('imports-test-file')
      const link = join(copy, 'entry', 'linked.ts')
      symlinkSync('/nonexistent', link)
      try {
        expect(unexplained(scanTree(copy)).join('\n')).toContain('entry/linked.ts:0 link')
      } finally {
        rmSync(link)
      }
    })

    it.each([
      ['lib/mcp/z1.ts', "import { spawn } from 'node:child_process'\nexport default spawn"],
      ['lib/mcp/z2.ts', "import { spawn } from 'child_process'\nexport default spawn"],
      ['lib/plugins/z3.ts', "export const c = require('node:child_process')"],
      ['lib/plugins/z4.ts', "import type { spawn } from 'node:child_process'\nexport type S = typeof spawn"],
      ['lib/plugins/z5.ts', "export * from '../../entry/watchdogHold'"],
      ['plugins/plugin-manager/z6.ts', "import { runWorker } from '../../entry/worker'\nexport default runWorker"],
      ['plugins/plugin-manager/z7.ts', "export const load = () => import('../../entry/devPlugins')"],
      ['kernel/z8.ts', "import { loadDevPlugins } from '../entry/devPlugins'\nexport default loadDevPlugins"],
      ['plugins/tools-coding/z9.ts', "export const m = 'plugins.dev.trust'"],
      ['lib/tools/z10.ts', 'export const m = `plugins.dev.remove`'],
    ])('layer rule: %s is flagged', (rel, text) => {
      expect(planted(rel, text, () => layerFindings(copy)).join('\n')).toContain(rel)
    })

    it('fetchGit.ts keeps its child_process, and the plugin-manager its own', () => {
      expect(layerFindings(copy).join('\n')).not.toContain('fetchGit')
      expect(planted('plugins/plugin-manager/ok.ts', "import { spawn } from 'node:child_process'\nexport default spawn", () => layerFindings(copy))).toEqual([])
    })
  })
})
