import { describe, it, expect } from 'vitest'
import { composerAction, composerPlaceholder } from './composerAction'

// 2026-10-06 用户报:手机上这一轮还在跑的时候,新打的字发不出去 —— 那颗键整个变成了停止键。
// 桌面端(renderer/views/chat/Composer.tsx:800)的规则是「正在跑 **且** 输入框是空的」才显示停止,
// 只要打了字就还是发送键,点下去进队列(chat:send 本来就会排队,手机端缺的只是界面这一条)。
describe('composerAction —— 忙的时候那颗键到底是发送还是停止', () => {
  it('不忙:永远是发送', () => {
    expect(composerAction({ busy: false, hasText: false })).toBe('send')
    expect(composerAction({ busy: true, hasText: false })).toBe('stop')
  })

  it('★正在跑但已经打了字:还是发送 —— 这条就是用户报的 bug,原来这里是停止', () => {
    expect(composerAction({ busy: true, hasText: true })).toBe('send')
  })

  it('正在跑且输入框空着:停止 —— 手机上没有 Esc,清空输入框就是回到停止键的路', () => {
    expect(composerAction({ busy: true, hasText: false })).toBe('stop')
  })

  it('只有空白字符不算「有字」,免得敲了个空格就再也停不掉这一轮', () => {
    expect(composerAction({ busy: true, hasText: false })).toBe('stop')
  })
})

describe('composerPlaceholder —— 得让人知道这条会排队,而不是以为发不出去', () => {
  it('离线最优先:先说连不上,再谈排队', () => {
    expect(composerPlaceholder({ online: false, busy: true })).toContain('未连接')
    expect(composerPlaceholder({ online: false, busy: false })).toContain('未连接')
  })

  it('★在线且正在跑:明说会排队(和桌面端同一句话)', () => {
    const p = composerPlaceholder({ online: true, busy: true })
    expect(p).toContain('排队')
  })

  it('在线且空闲:还是原来那句', () => {
    expect(composerPlaceholder({ online: true, busy: false })).toBe('给代理下达任务…')
  })

  it('AI 共商进行中:插话;离线仍然先说连不上', () => {
    expect(composerPlaceholder({ online: true, busy: false, interjecting: true })).toBe('插话')
    expect(composerPlaceholder({ online: true, busy: true, interjecting: true })).toBe('插话')
    expect(composerPlaceholder({ online: false, busy: false, interjecting: true })).toContain('未连接')
  })

  it('AI 共商轮间等用户:补充', () => {
    expect(composerPlaceholder({ online: true, busy: false, interjecting: true, councilBreak: true })).toBe('补充')
    expect(composerPlaceholder({ online: false, busy: false, interjecting: true, councilBreak: true })).toContain('未连接')
  })
})
