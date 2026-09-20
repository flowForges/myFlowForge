import { describe, it, expect } from 'vitest'
import { pendingLabel, settlePending } from './pendingAttachment'
import { insertPastePlaceholder } from '../../../src/shared/chat/largePaste'

/** 真实用法:在末尾插一个「正在保存 …」的占位符,和 `chat.tsx` 里那三条路一模一样。 */
const insert = (text: string, name: string): string =>
  insertPastePlaceholder(text, text.length, text.length, pendingLabel(name)).text

describe('传输中的附件占位符', () => {
  it('插进去的时候看得出是「正在保存」哪一个', () => {
    expect(insert('看看这个', 'IMG_1.jpg')).toBe('看看这个 [正在保存 IMG_1.jpg…]')
  })

  it('传完了换成真名字,前后的字一个不动', () => {
    const t = insert('看看这个', 'IMG_1.jpg')
    expect(settlePending(t, 'IMG_1.jpg', 'IMG_1.jpg')).toBe('看看这个 [IMG_1.jpg]')
  })

  it('★换的是**服务端回的**名字 —— 撞名去重时它和送上去的那个不一样', () => {
    const t = insert('第二张', 'image.jpg')
    expect(settlePending(t, 'image.jpg', 'image-2.jpg')).toBe('第二张 [image-2.jpg]')
  })

  it('★★这几秒里人接着打的字必须留着 —— 只换自己那一段,不整段写回', () => {
    const t = insert('看看这个', 'IMG_1.jpg')
    const typed = `${t} 顺便帮我改一下标题`
    expect(settlePending(typed, 'IMG_1.jpg', 'IMG_1.jpg')).toBe('看看这个 [IMG_1.jpg] 顺便帮我改一下标题')
  })

  it('★★人在占位符**前面**插了字也一样 —— 靠找自己那一段,不靠下标', () => {
    const t = insert('看看这个', 'IMG_1.jpg')
    const typed = `急:${t}`
    expect(settlePending(typed, 'IMG_1.jpg', 'IMG_1.jpg')).toBe('急:看看这个 [IMG_1.jpg]')
  })

  it('★人已经把占位符删了 = 他不想要了,原样返回,不替他加回来', () => {
    expect(settlePending('看看这个', 'IMG_1.jpg', 'IMG_1.jpg')).toBe('看看这个')
    expect(settlePending('', 'IMG_1.jpg', 'IMG_1.jpg')).toBe('')
  })

  it('★传砸了就把占位符收干净 —— 留一句「正在保存」在那儿是在撒谎', () => {
    const t = insert('看看这个', 'IMG_1.jpg')
    expect(settlePending(t, 'IMG_1.jpg', null)).toBe('看看这个')
  })

  it('★收的时候连它自己带进来的那个空格一起收,不留双空格', () => {
    const t = insert('看看这个', 'IMG_1.jpg')
    const typed = `${t} 后面还有话`
    expect(settlePending(typed, 'IMG_1.jpg', null)).toBe('看看这个 后面还有话')
  })

  it('从空输入框开始时不会收出一个前导空格', () => {
    const t = insert('', 'IMG_1.jpg')
    expect(t).toBe('[正在保存 IMG_1.jpg…]')
    expect(settlePending(t, 'IMG_1.jpg', null)).toBe('')
  })

  it('★连拍两张,两个占位符各收各的 —— 标签里带着文件名就是为了这个', () => {
    let t = insert('两张', 'a.jpg')
    t = insert(t, 'b.jpg')
    expect(t).toBe('两张 [正在保存 a.jpg…] [正在保存 b.jpg…]')
    t = settlePending(t, 'b.jpg', 'b.jpg')
    expect(t).toBe('两张 [正在保存 a.jpg…] [b.jpg]')
    t = settlePending(t, 'a.jpg', 'a.jpg')
    expect(t).toBe('两张 [a.jpg] [b.jpg]')
  })
})
