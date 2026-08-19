import { describe, it, expect } from 'vitest'
import { classifyHref, stripFileProtocol, stripHrefSuffix, previewKindOf, extOf, isHtmlFile } from './fileRef'

describe('classifyHref', () => {
  it('http/https 是外链', () => {
    expect(classifyHref('https://example.com/a')).toBe('external')
    expect(classifyHref('HTTP://example.com')).toBe('external')
  })
  it('#锚点不是文件', () => {
    expect(classifyHref('#section')).toBe('anchor')
    expect(classifyHref('  ')).toBe('anchor')
  })
  it('相对/绝对/file: 都是路径', () => {
    expect(classifyHref('docs/design.md')).toBe('path')
    expect(classifyHref('./out/index.html')).toBe('path')
    expect(classifyHref('/Users/x/a.png')).toBe('path')
    expect(classifyHref('file:///Users/x/a.png')).toBe('path')
  })
  it('mailto/javascript/data 不当文件', () => {
    expect(classifyHref('mailto:a@b.com')).toBe('anchor')
    expect(classifyHref('javascript:alert(1)')).toBe('anchor')
    expect(classifyHref('data:image/png;base64,AAA')).toBe('anchor')
  })
  it('Windows 盘符是路径,不是协议', () => {
    expect(classifyHref('C:\\Users\\x\\a.md')).toBe('path')
    expect(classifyHref('D:/work/a.md')).toBe('path')
  })
})

describe('stripFileProtocol', () => {
  it('剥掉 file:// 还原绝对路径', () => {
    expect(stripFileProtocol('file:///Users/x/a b.png')).toBe('/Users/x/a b.png')
  })
  it('非 file: 原样', () => {
    expect(stripFileProtocol('docs/a.md')).toBe('docs/a.md')
  })
})

describe('stripHrefSuffix', () => {
  it('剥掉锚点与 query', () => {
    expect(stripHrefSuffix('docs/a.md#标题')).toBe('docs/a.md')
    expect(stripHrefSuffix('docs/a.md?v=1')).toBe('docs/a.md')
    expect(stripHrefSuffix('docs/a.md')).toBe('docs/a.md')
  })
})

describe('previewKindOf', () => {
  it('图片', () => {
    expect(previewKindOf('a/b/shot.PNG')).toBe('image')
    expect(previewKindOf('d.svg')).toBe('image')
  })
  it('markdown', () => {
    expect(previewKindOf('docs/design.md')).toBe('markdown')
    expect(previewKindOf('README.markdown')).toBe('markdown')
  })
  it('html 走文本预览(不是丢给系统)', () => {
    expect(previewKindOf('out/index.html')).toBe('text')
  })
  it('二进制类走系统默认程序', () => {
    expect(previewKindOf('报告.pdf')).toBe('system')
    expect(previewKindOf('data.xlsx')).toBe('system')
    expect(previewKindOf('bundle.zip')).toBe('system')
  })
  it('无后缀当文本', () => {
    expect(previewKindOf('LICENSE')).toBe('text')
    expect(previewKindOf('.gitignore')).toBe('text')
  })
})

describe('extOf', () => {
  it('只看最后一段,点开头不算后缀', () => {
    expect(extOf('a.b/c')).toBe('')
    expect(extOf('.env')).toBe('')
    expect(extOf('a.tar.gz')).toBe('gz')
  })
})

describe('isHtmlFile', () => {
  it('html/htm 才给浏览器按钮', () => {
    expect(isHtmlFile('a/index.html')).toBe(true)
    expect(isHtmlFile('a/index.HTM')).toBe(true)
    expect(isHtmlFile('a/index.md')).toBe(false)
  })
})
