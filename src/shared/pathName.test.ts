import { describe, it, expect } from 'vitest'
import { baseName } from './pathName'

// 渲染层拿不到 node:path,于是到处写 `p.split('/').pop()` 来取路径最后一段。
// 那在 Windows 上会**整条路径原样返回** —— 工作区会叫「C:\Users\me\proj」,终端标签同理。
describe('baseName', () => {
  it('POSIX 路径取最后一段', () => {
    expect(baseName('/Users/me/work/myapp')).toBe('myapp')
  })

  it('★ Windows 路径取最后一段(旧的 split("/") 在这儿会返回整条路径)', () => {
    expect(baseName('C:\\Users\\me\\work\\myapp')).toBe('myapp')
  })

  it('忽略结尾的分隔符,两种都认', () => {
    expect(baseName('/Users/me/work/')).toBe('work')
    expect(baseName('C:\\Users\\me\\work\\')).toBe('work')
    expect(baseName('/Users/me/work///')).toBe('work')
  })

  it('混合分隔符也能处理(Windows 上两种都合法,且 API 返回的常常是混的)', () => {
    expect(baseName('C:\\Users\\me/work\\myapp')).toBe('myapp')
    expect(baseName('C:/Users/me/work/myapp')).toBe('myapp')
  })

  it('名字里带空格和中文照常', () => {
    expect(baseName('C:\\Users\\me\\我的 项目')).toBe('我的 项目')
    expect(baseName('/Users/me/My Project')).toBe('My Project')
  })

  it('没有分隔符时原样返回', () => {
    expect(baseName('myapp')).toBe('myapp')
  })

  it('盘符根 / 文件系统根 不会返回空串', () => {
    expect(baseName('C:\\')).toBe('C:')
    expect(baseName('/')).toBe('')
  })

  it('空串安全', () => {
    expect(baseName('')).toBe('')
  })
})
