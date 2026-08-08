import { describe, it, expect } from 'vitest'
import { highlight, highlightBlock, HIGHLIGHT_MAX } from './highlight'

describe('highlight', () => {
  it('marks keywords, strings, and line comments for a known language', () => {
    const toks = highlight(`const x = "hi" // note`, 'ts')
    expect(toks.some(t => t.cls === 'kw' && t.text === 'const')).toBe(true)
    expect(toks.some(t => t.cls === 'st' && t.text.includes('hi'))).toBe(true)
    expect(toks.some(t => t.cls === 'cm' && t.text.includes('// note'))).toBe(true)
    expect(toks.map(t => t.text).join('')).toBe(`const x = "hi" // note`)
  })
  it('returns a single plain token for an unknown language', () => {
    expect(highlight('const x = 1', 'text')).toEqual([{ cls: null, text: 'const x = 1' }])
  })
  it('treats a # line as a comment in python', () => {
    const toks = highlight('# hello', 'py')
    expect(toks).toEqual([{ cls: 'cm', text: '# hello' }])
  })
  it('highlights go keywords, a string and a // comment', () => {
    const toks = highlight('func main() { return "hi" } // c', 'go')
    expect(toks.some(t => t.cls === 'kw' && t.text === 'func')).toBe(true)
    expect(toks.some(t => t.cls === 'kw' && t.text === 'return')).toBe(true)
    expect(toks.some(t => t.cls === 'st' && t.text.includes('hi'))).toBe(true)
    expect(toks.some(t => t.cls === 'cm' && t.text.includes('// c'))).toBe(true)
    expect(toks.map(t => t.text).join('')).toBe('func main() { return "hi" } // c')
  })
  it('resolves language aliases (golang→go, typescript→ts)', () => {
    expect(highlight('func x()', 'golang').some(t => t.cls === 'kw' && t.text === 'func')).toBe(true)
    expect(highlight('const x = 1', 'typescript').some(t => t.cls === 'kw' && t.text === 'const')).toBe(true)
    expect(highlight('const x = 1', 'javascript').some(t => t.cls === 'kw' && t.text === 'const')).toBe(true)
  })
  it('tags numeric literals as numbers', () => {
    const toks = highlight('let x = 42', 'ts')
    expect(toks.some(t => t.cls === 'nu' && t.text === '42')).toBe(true)
  })
  it('highlights sql keywords case-insensitively', () => {
    const toks = highlight('SELECT * FROM t', 'sql')
    expect(toks.some(t => t.cls === 'kw' && /select/i.test(t.text))).toBe(true)
  })
})

describe('highlightBlock', () => {
  // ★最重要的不变量:着色是纯粹的"给字符分组",一个字符都不能吞。所有语言的用例都过这一关。
  const roundTrip = (code: string, lang?: string): void => {
    expect(highlightBlock(code, lang).map(t => t.text).join('')).toBe(code)
  }
  const clsOf = (code: string, lang: string, text: string): (string | null)[] =>
    highlightBlock(code, lang).filter(t => t.text === text).map(t => t.cls)

  it('没写语言的围栏不着色(日志/纯文本块不该被乱上色)', () => {
    expect(highlightBlock('const x = 1')).toEqual([{ cls: null, text: 'const x = 1' }])
    expect(highlightBlock('const x = 1', '  ')).toEqual([{ cls: null, text: 'const x = 1' }])
  })

  it('超长块直接返回纯文本(不切成上万个 span)', () => {
    // 用【真会被分词】的内容:'a'.repeat() 本身只会分出一个纯文本 token,那样即使守卫没了测试也照过
    // (变异测试抓到过这个假绿)。这段每行都有关键字 + 数字,没守卫就会切出好几万个 token。
    const huge = 'const x = 1;\n'.repeat(Math.ceil(HIGHLIGHT_MAX / 13) + 1)
    expect(huge.length).toBeGreaterThan(HIGHLIGHT_MAX)
    expect(highlightBlock(huge, 'ts')).toEqual([{ cls: null, text: huge }])
  })

  it('JSON:键与字符串值分开上色', () => {
    const code = '{\n  "name": "forge",\n  "port": 8080,\n  "ok": true\n}'
    roundTrip(code, 'json')
    expect(clsOf(code, 'json', '"name"')).toEqual(['pr'])
    expect(clsOf(code, 'json', '"forge"')).toEqual(['st'])
    expect(clsOf(code, 'json', '8080')).toEqual(['nu'])
    expect(clsOf(code, 'json', 'true')).toEqual(['kw'])
  })

  it('SQL:关键字大小写不敏感,`--` 是注释不是运算符', () => {
    const code = "SELECT id FROM users -- 只取 id\nwhere name = 'z'"
    roundTrip(code, 'sql')
    expect(clsOf(code, 'sql', 'SELECT')).toEqual(['kw'])
    expect(clsOf(code, 'sql', 'where')).toEqual(['kw'])
    expect(highlightBlock(code, 'sql').some(t => t.cls === 'cm' && t.text === '-- 只取 id')).toBe(true)
    expect(highlightBlock(code, 'sql').some(t => t.cls === 'st' && t.text === "'z'")).toBe(true)
  })

  it('TS:跨行块注释整段是注释(逐行分词做不到这件事)', () => {
    const code = 'const a = 1\n/* 这里\n   跨了两行 const 不该变关键字 */\nconst b = 2'
    roundTrip(code, 'ts')
    const cm = highlightBlock(code, 'ts').filter(t => t.cls === 'cm')
    expect(cm).toHaveLength(1)
    expect(cm[0].text).toContain('跨了两行')
    // 注释里的 const 被包在注释 token 里,没有单独冒出来 → 只剩注释外的两个
    expect(clsOf(code, 'ts', 'const')).toEqual(['kw', 'kw'])
  })

  it('TS:函数名 / 内置类型 / 大写标识符各有色位', () => {
    const code = 'const p: Promise<User> = fetchUser(1)'
    roundTrip(code, 'ts')
    expect(clsOf(code, 'ts', 'Promise')).toEqual(['ty'])
    expect(clsOf(code, 'ts', 'User')).toEqual(['ty'])
    expect(clsOf(code, 'ts', 'fetchUser')).toEqual(['fn'])
  })

  it('未闭合的引号不会把后面整段代码染成字符串', () => {
    const code = "const a = 'oops\nconst b = 2"
    roundTrip(code, 'ts')
    const st = highlightBlock(code, 'ts').filter(t => t.cls === 'st')
    expect(st.every(t => !t.text.includes('\n'))).toBe(true)
    expect(clsOf(code, 'ts', 'const')).toEqual(['kw', 'kw'])
  })

  it('模板字符串可以跨行(反引号例外)', () => {
    const code = 'const t = `line1\nline2`'
    roundTrip(code, 'ts')
    expect(highlightBlock(code, 'ts').some(t => t.cls === 'st' && t.text.includes('\n'))).toBe(true)
  })

  it('Python:三引号 docstring 整段是字符串', () => {
    const code = 'def f():\n    """说明\n    第二行"""\n    return 1'
    roundTrip(code, 'py')
    expect(highlightBlock(code, 'py').some(t => t.cls === 'st' && t.text.includes('第二行'))).toBe(true)
    expect(clsOf(code, 'py', 'def')).toEqual(['kw'])
  })

  it('shell:$VAR 是变量,# 是注释', () => {
    const code = 'echo "$HOME/bin" # 路径'
    roundTrip(code, 'sh')
    expect(clsOf(code, 'sh', 'echo')).toEqual(['kw'])
    expect(highlightBlock(code, 'sh').some(t => t.cls === 'cm' && t.text === '# 路径')).toBe(true)
  })

  it('CSS:属性名是键、--自定义属性是变量、带单位的数值是数字', () => {
    const code = '.a { font-size: 12px; color: var(--accent); }'
    roundTrip(code, 'css')
    expect(clsOf(code, 'css', 'font-size')).toEqual(['pr'])
    expect(clsOf(code, 'css', '--accent')).toEqual(['va'])
    expect(clsOf(code, 'css', '12px')).toEqual(['nu'])
  })

  it('HTML:标签名与属性名分开,<!-- --> 是注释', () => {
    const code = '<!-- 说明 -->\n<div class="a">文字</div>'
    roundTrip(code, 'html')
    const toks = highlightBlock(code, 'html')
    expect(toks.some(t => t.cls === 'cm' && t.text === '<!-- 说明 -->')).toBe(true)
    expect(toks.some(t => t.cls === 'tg' && t.text === 'div')).toBe(true)
    expect(toks.some(t => t.cls === 'at' && t.text === 'class')).toBe(true)
    expect(toks.some(t => t.cls === 'st' && t.text === '"a"')).toBe(true)
  })

  it('别名解析到同一套语法(golang/python3/bash/postgres/c++)', () => {
    expect(clsOf('func main()', 'golang', 'func')).toEqual(['kw'])
    expect(clsOf('def f()', 'python3', 'def')).toEqual(['kw'])
    expect(clsOf('echo hi', 'bash', 'echo')).toEqual(['kw'])
    expect(clsOf('SELECT 1', 'postgres', 'SELECT')).toEqual(['kw'])
    expect(clsOf('int main()', 'c++', 'int')).toEqual(['ty'])
  })

  it('未登记的语言仍认字符串 / 数字 / 注释,但不乱认关键字', () => {
    const code = 'set x "hi" 42 // note'
    roundTrip(code, 'tcl')
    const toks = highlightBlock(code, 'tcl')
    expect(toks.some(t => t.cls === 'st' && t.text === '"hi"')).toBe(true)
    expect(toks.some(t => t.cls === 'nu' && t.text === '42')).toBe(true)
    expect(toks.some(t => t.cls === 'cm' && t.text === '// note')).toBe(true)
    expect(toks.some(t => t.cls === 'kw')).toBe(false)
  })

  it('中文注释 / 中文字符串不被拆坏', () => {
    const code = '// 这是中文注释\nconst 名字 = "中文值"'
    roundTrip(code, 'ts')
  })

  it('空字符串与只有换行的块不炸', () => {
    expect(highlightBlock('', 'ts')).toEqual([])
    roundTrip('\n\n\n', 'ts')
  })
})
