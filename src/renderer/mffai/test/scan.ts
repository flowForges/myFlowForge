// 源码扫描(08 §6.4、评审修订 R6、R14)。规则是测试本身,扫描器和白名单放在 test/ 里,自己不受扫。
import ts from 'typescript'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** 唯二的长标签(spec §16),和 ui/AutoSwitch.tsx 逐字相同(AutoSwitch.test 钉住) */
export const ALLOWLIST: readonly string[] = [
  '自动放行 · 命令不经你看 · 能读凭据清单以外的文件',
  '无沙箱时自动放行 · 命令不隔离 · 能读写凭据清单以外的文件',
]

/**
 * 早于这条规则的调试面板:它的 placeholder 被现有 DebugPanel.test.tsx 按 getByPlaceholderText 钉着,
 * 而那个测试按全局约束不能改。只免这一处、这一条规则、这一个值
 */
export const LEGACY: readonly { file: string; rule: Rule; text: string }[] = [
  { file: 'DebugPanel.tsx', rule: 'placeholder', text: '工作目录' },
]

export const MAX_CJK = 14
const CJK = /[㐀-䶿一-鿿豈-﫿]/g
const SENTENCE = /[。，；！？]/

export type Rule = 'cjk-length' | 'punctuation' | 'placeholder' | 'dangerouslySetInnerHTML' | 'protocol-value-import'
export interface Violation { file: string; line: number; rule: Rule; text: string }

export const cjkCount = (s: string) => s.match(CJK)?.length ?? 0

/** dir 下的 .ts/.tsx,不含测试、test/ 目录和 .d.ts;路径相对 dir */
export function listSources(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) { if (ent.name !== 'test' && ent.name !== 'node_modules') walk(p); continue }
      if (!/\.tsx?$/.test(ent.name) || /\.test\.tsx?$/.test(ent.name) || ent.name.endsWith('.d.ts')) continue
      out.push(relative(dir, p).split(sep).join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

const parse = (file: string, text: string) =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

const stringOf = (n: ts.Node | undefined): string | undefined => {
  if (!n) return undefined
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text
  if (ts.isJsxExpression(n)) return stringOf(n.expression)
  if (ts.isTemplateExpression(n)) return [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join('')
  if (ts.isParenthesizedExpression(n)) return stringOf(n.expression)
  return undefined
}

const nameOf = (n: ts.Node): string | undefined =>
  ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : ts.isJsxNamespacedName(n) ? n.name.text : undefined

/** 说明文字:超长汉字、句子标点、汉字 placeholder、dangerouslySetInnerHTML */
export function scanHintText(file: string, text: string): Violation[] {
  const sf = parse(file, text)
  const out: Violation[] = []
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const push = (n: ts.Node, rule: Rule, t: string) => {
    const base = file.split('/').pop()!
    if (LEGACY.some((l) => l.file === base && l.rule === rule && l.text === t)) return
    out.push({ file, line: line(n), rule, text: t })
  }
  const checkText = (n: ts.Node, t: string) => {
    if (ALLOWLIST.includes(t.trim())) return
    if (cjkCount(t) > MAX_CJK) push(n, 'cjk-length', t)
    if (SENTENCE.test(t)) push(n, 'punctuation', t)
  }
  const checkPlaceholder = (n: ts.Node, value: ts.Node | undefined) => {
    const v = stringOf(value)
    if (v !== undefined && cjkCount(v) > 0) push(n, 'placeholder', v)
  }

  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (!ts.isImportDeclaration(n.parent) && !ts.isExportDeclaration(n.parent)) checkText(n, n.text)
    } else if (ts.isTemplateExpression(n)) {
      // 每段静态部分,再加拼起来的整段:被 ${x} 隔开的两半也是一句话
      const parts = [n.head, ...n.templateSpans.map((s) => s.literal)]
      for (const part of parts) checkText(part, part.text)
      const joined = parts.map((p) => p.text).join('')
      if (parts.every((p) => cjkCount(p.text) <= MAX_CJK)) checkText(n, joined)
    } else if (ts.isJsxElement(n) || ts.isJsxFragment(n)) {
      // 相邻的 JSX 文字片段先拼起来(被 {x} 隔开的也算一段话)
      const joined = n.children.map((c) => (ts.isJsxText(c) ? c.text : ts.isJsxExpression(c) ? stringOf(c) ?? '' : '')).join('')
      if (joined.trim()) checkText(n, joined)
    } else if (ts.isJsxAttribute(n)) {
      const name = nameOf(n.name)
      if (name === 'dangerouslySetInnerHTML') push(n, 'dangerouslySetInnerHTML', name)
      if (name === 'placeholder') checkPlaceholder(n, n.initializer)
    } else if (ts.isPropertyAssignment(n)) {
      const name = nameOf(n.name)
      if (name === 'dangerouslySetInnerHTML') push(n, 'dangerouslySetInnerHTML', name)
      if (name === 'placeholder') checkPlaceholder(n, n.initializer)
    } else if (ts.isIdentifier(n) && n.text === 'dangerouslySetInnerHTML' && !ts.isPropertyAssignment(n.parent) && !ts.isJsxAttribute(n.parent)) {
      push(n, 'dangerouslySetInnerHTML', n.text)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

const PROTOCOL = '@mffai/protocol'

/** 渲染层对裸 @mffai/protocol 只许 import type / export type(R14),值只经 /browser */
export function scanProtocolImports(file: string, text: string): Violation[] {
  const sf = parse(file, text)
  const out: Violation[] = []
  const push = (n: ts.Node, t: string) => out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, rule: 'protocol-value-import', text: t })
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && stringOf(n.moduleSpecifier) === PROTOCOL && !n.importClause?.isTypeOnly) push(n, n.getText(sf))
    else if (ts.isExportDeclaration(n) && n.moduleSpecifier && stringOf(n.moduleSpecifier) === PROTOCOL && !n.isTypeOnly) push(n, n.getText(sf))
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && stringOf(n.moduleReference.expression) === PROTOCOL && !n.isTypeOnly) push(n, n.getText(sf))
    else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require')) && stringOf(n.arguments[0]) === PROTOCOL) push(n, n.getText(sf))
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

export function scanTree(dir: string, scan: (file: string, text: string) => Violation[]): Violation[] {
  return listSources(dir).flatMap((f) => scan(f, readFileSync(join(dir, f), 'utf8')))
}
