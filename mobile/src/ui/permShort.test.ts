import { describe, it, expect } from 'vitest'
import { permShort } from './permShort'
import { PERMISSION_MODES } from '../../../src/shared/permissions'

describe('权限键上那两个字', () => {
  it('三档各有各的短名', () => {
    expect(permShort('readonly')).toBe('只读')
    expect(permShort('auto')).toBe('自动')
    expect(permShort('full')).toBe('全权')
  })

  it('★★每一档都得有 —— 将来加第四档时,这条会替你把漏的那一档抓出来', () => {
    // 权限键是安全相关的:漏一档的后果是那颗键上一片空白,而人照样按了发送。
    for (const m of PERMISSION_MODES) {
      expect(permShort(m.id), m.id).toBeTruthy()
    }
  })

  it('★都是两个字 —— 键宽是按两个字算的,三个字会把输入框再挤窄一截', () => {
    for (const m of PERMISSION_MODES) expect(permShort(m.id).length).toBe(2)
  })
})
