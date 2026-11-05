// 边界测试的扫描器(09 spec §12):harness/src 里除了 entry/devPlugins.ts,没有别的路能把代码载进工作进程。
// 用语法树,不用正则:注释和字符串里的字样不算,`eval`、`'node:vm'` 算。
// 防的是将来有人顺手加一条路,不是有心绕过:`const p = process; p['dl' + 'open']` 这种先取别名再拼名字的抓不到,
// 字符串里的代码也不读(内联的两段源码由 boundary.test.ts 单独钉住)。
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'

export type Kind =
  | 'dynamic-import'
  | 'require'
  | 'eval'
  | 'function-constructor'
  | 'forbidden-module'
  | 'create-require'
  | 'dlopen'
  | 'global-alias'
  | 'loader-internal'
  | 'worker'
  | 'code-url'
  | 'imports-test-file'
  | 'node-eval-flag'
  | 'native-file'
  | 'link'
  | 'unparseable'

export interface Finding {
  file: string
  kind: Kind
  /** 从 1 起;整个文件的问题(链接、原生模块)是 0 */
  line: number
  text: string
}

const FORBIDDEN_MODULES = new Set(['vm', 'module', 'worker_threads', 'repl', 'inspector', 'inspector/promises', 'wasi'])
const CODE_URL = /^(?:data|https?|blob|file):/i
const TEST_FILE = /\.test(?:\.[cm]?[jt]sx?)?$/
/** 给 node 递代码的命令行选项 */
const NODE_EVAL_FLAGS = new Set(['-e', '--eval', '--print', '-pe', '--import', '--require', '--loader', '--experimental-loader'])

/** 这些名字不管出现在哪(变量、属性、解构、对象键、`x['名字']`、Reflect 的参数)都算 */
const NAMES = new Map<string, Kind>([
  ['eval', 'eval'],
  ['Function', 'function-constructor'],
  ['AsyncFunction', 'function-constructor'],
  ['GeneratorFunction', 'function-constructor'],
  ['AsyncGeneratorFunction', 'function-constructor'],
  ['constructor', 'function-constructor'], // 任何函数的 .constructor 都是 Function
  ['createRequire', 'create-require'],
  ['dlopen', 'dlopen'],
  ['mainModule', 'loader-internal'],
  ['getBuiltinModule', 'loader-internal'],
  ['_linkedBinding', 'loader-internal'],
  ['_load', 'loader-internal'],
  ['_compile', 'loader-internal'],
  ['_extensions', 'loader-internal'],
  ['WebAssembly', 'loader-internal'],
  ['ShadowRealm', 'loader-internal'],
])
/** 拿到它们之后,方括号里写什么都看不出来 */
const GLOBALS = new Set(['globalThis', 'global', 'process', 'module', 'require'])

const isKeyPosition = (n: ts.Node): boolean => {
  const p = n.parent
  return (ts.isPropertyAccessExpression(p) && p.name === n) || ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name === n)
}

export function scanSource(text: string, file = 'x.ts'): Finding[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const out: Finding[] = []
  const add = (n: ts.Node, kind: Kind, what?: string) => {
    out.push({ file, kind, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text: what ?? n.getText(sf) })
  }
  const diagnostics = (sf as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
  if (diagnostics.length > 0) out.push({ file, kind: 'unparseable', line: 0, text: String(ts.flattenDiagnosticMessageText(diagnostics[0].messageText, ' ')) })

  /** 字面量说明符:它指向哪 */
  const checkSpecifier = (n: ts.Node, spec: string) => {
    if (FORBIDDEN_MODULES.has(spec.replace(/^node:/, ''))) add(n, 'forbidden-module', spec)
    if (CODE_URL.test(spec)) add(n, 'code-url', spec)
    if (TEST_FILE.test(spec)) add(n, 'imports-test-file', spec)
  }
  const checkName = (n: ts.Node, name: string) => {
    const kind = NAMES.get(name)
    if (kind) add(n, kind, name)
    if (name === 'require') add(n, 'require', name)
  }

  const visit = (n: ts.Node): void => {
    // 类型只在编译时存在。import type 例外:下面的说明符检查照看
    if (ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return

    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)) checkSpecifier(n.moduleSpecifier, n.moduleSpecifier.text)
    if (ts.isExternalModuleReference(n) && ts.isStringLiteralLike(n.expression)) checkSpecifier(n.expression, n.expression.text)

    if (ts.isCallExpression(n)) {
      const callee = n.expression
      const arg = n.arguments[0]
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        if (arg && ts.isStringLiteralLike(arg)) checkSpecifier(arg, arg.text)
        else add(n, 'dynamic-import')
      } else if (ts.isIdentifier(callee) && callee.text === 'require' && arg && ts.isStringLiteralLike(arg)) {
        checkSpecifier(arg, arg.text)
        for (const a of n.arguments) visit(a)
        return // 只有 require('字面量') 这一种写法不算
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'Reflect') {
        for (const a of n.arguments) if (ts.isStringLiteralLike(a)) checkName(a, a.text)
      }
    }

    if (ts.isNewExpression(n)) {
      const callee = n.expression
      if ((ts.isIdentifier(callee) && callee.text === 'Worker') || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'Worker')) add(n, 'worker')
    }

    if (ts.isElementAccessExpression(n)) {
      const key = n.argumentExpression
      if (ts.isStringLiteralLike(key)) {
        checkName(key, key.text)
        if (key.text === 'binding' && ts.isIdentifier(n.expression) && n.expression.text === 'process') add(n, 'loader-internal')
      } else if (ts.isIdentifier(n.expression) && GLOBALS.has(n.expression.text)) add(n, 'global-alias')
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'binding' && ts.isIdentifier(n.expression) && n.expression.text === 'process') add(n, 'loader-internal')
    // { 'eval': x }、const { 'eval': e } = globalThis
    if (ts.isPropertyAssignment(n) && ts.isStringLiteralLike(n.name)) checkName(n.name, n.name.text)
    if (ts.isBindingElement(n) && n.propertyName && ts.isStringLiteralLike(n.propertyName)) checkName(n.propertyName, n.propertyName.text)

    if (ts.isStringLiteralLike(n) && NODE_EVAL_FLAGS.has(n.text)) add(n, 'node-eval-flag')

    if (ts.isIdentifier(n)) {
      checkName(n, n.text)
      // globalThis.x 可以;整个拿走不行。别人的同名属性(`o.global`、`{ global: 1 }`)不算
      if ((n.text === 'globalThis' || n.text === 'global') && !isKeyPosition(n)) {
        const p = n.parent
        const member = (ts.isPropertyAccessExpression(p) && p.expression === n) || (ts.isElementAccessExpression(p) && p.expression === n)
        if (!member) add(n, 'global-alias')
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/
const NATIVE = /\.(?:node|wasm|dylib|so|dll)$/
const TEST = /\.test\.[cm]?[jt]sx?$/

/** 不跟链接。测试文件不读 */
export function codeFiles(root: string): { abs: string; rel: string; link: boolean; native: boolean }[] {
  const out: { abs: string; rel: string; link: boolean; native: boolean }[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      const st = lstatSync(abs)
      const rel = relative(root, abs).split(sep).join('/')
      if (st.isSymbolicLink()) out.push({ abs, rel, link: true, native: false })
      else if (st.isDirectory()) walk(abs)
      else if (NATIVE.test(name)) out.push({ abs, rel, link: false, native: true })
      else if (CODE.test(name) && !TEST.test(name)) out.push({ abs, rel, link: false, native: false })
    }
  }
  walk(root)
  return out
}

/** 同一份文本不解析第二次:种文件的用例要把整棵树看几十遍 */
const parsed = new Map<string, Finding[]>()

export function scanTree(root: string): Finding[] {
  return codeFiles(root).flatMap(f => {
    if (f.link) return [{ file: f.rel, kind: 'link' as const, line: 0, text: 'symlink' }]
    if (f.native) return [{ file: f.rel, kind: 'native-file' as const, line: 0, text: 'native code' }]
    const text = readFileSync(f.abs, 'utf8')
    const key = `${f.rel}\0${text}`
    const hit = parsed.get(key)
    if (hit) return hit
    const found = scanSource(text, f.rel)
    parsed.set(key, found)
    return found
  })
}

/** 所有说明符:import、import type、export from、import x = require、动态 import、require,只要是字面量 */
export function importsOf(text: string, file = 'x.ts'): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)) out.push(n.moduleSpecifier.text)
    if (ts.isExternalModuleReference(n) && ts.isStringLiteralLike(n.expression)) out.push(n.expression.text)
    if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteralLike(n.argument.literal)) out.push(n.argument.literal.text)
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require')) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) out.push(n.arguments[0].text)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** 代码里的字符串字面量,不含注释 */
export function stringsOf(text: string, file = 'x.ts'): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n)) out.push(n.text)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}
