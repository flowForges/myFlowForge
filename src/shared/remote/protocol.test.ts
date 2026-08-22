import { describe, it, expect } from 'vitest'
import { decodeFrame, encodeFrame, errorText, PROTOCOL_VERSION, type Frame } from './protocol'

describe('线协议', () => {
  it('编解码往返不丢东西', () => {
    const frames: Frame[] = [
      { t: 'hello', protocol: PROTOCOL_VERSION, version: '1.1.2', authRequired: false },
      { t: 'auth', token: 'abc' },
      { t: 'ready', methods: ['config:get-settings', 'chat:send'] },
      { t: 'req', id: 7, ch: 'chat:send', args: [{ text: '你好' }] },
      { t: 'res', id: 7, ok: true, value: { messages: [] } },
      { t: 'res', id: 8, ok: false, error: 'boom' },
      { t: 'evt', ch: 'chat:event', payload: { type: 'delta' } },
      { t: 'ping' },
      { t: 'pong' },
    ]
    for (const f of frames) {
      const d = decodeFrame(encodeFrame(f))
      expect(d.ok, `${f.t} 应该能解回来`).toBe(true)
      if (d.ok) expect(d.frame).toEqual(f)
    }
  })

  it('CJK 走 UTF-8 字节也能解回来(手机端会发中文)', () => {
    const f: Frame = { t: 'req', id: 1, ch: 'chat:send', args: ['把这个 bug 修了,跑一遍测试'] }
    const bytes = new TextEncoder().encode(encodeFrame(f))
    const d = decodeFrame(bytes)
    expect(d.ok && d.frame).toEqual(f)
  })

  it.each([
    ['不是 json', 'hello world'],
    ['空串', ''],
    ['json 但不是帧', '{"foo":1}'],
    ['帧类型不认识', '{"t":"exec","cmd":"rm -rf /"}'],
    ['req 缺 id', '{"t":"req","ch":"chat:send","args":[]}'],
    ['req 的 id 是字符串', '{"t":"req","id":"1","ch":"a","args":[]}'],
    ['req 的 id 是负数', '{"t":"req","id":-1,"ch":"a","args":[]}'],
    ['req 的 args 不是数组', '{"t":"req","id":1,"ch":"a","args":"x"}'],
    ['res 的 ok 是字符串', '{"t":"res","id":1,"ok":"true","value":1}'],
    ['null', 'null'],
    ['裸数组', '[1,2,3]'],
  ])('垃圾输入「%s」只返回失败,绝不抛', (_label, raw) => {
    // ★这条是拒绝服务防线:网关的消息循环里一个未捕获异常,就是一个任何人都能远程触发的崩溃。
    expect(() => decodeFrame(raw)).not.toThrow()
    expect(decodeFrame(raw).ok).toBe(false)
  })

  it('req 的 args 允许含 null(handler 参数本来就可能是 null)', () => {
    const d = decodeFrame('{"t":"req","id":1,"ch":"a","args":[null,{"x":1}]}')
    expect(d.ok).toBe(true)
    if (d.ok && d.frame.t === 'req') expect(d.frame.args).toEqual([null, { x: 1 }])
  })

  it('errorText 只带走一句话,不带 stack 也不带抛出者挂的任意属性', () => {
    // ★真实存在:spawn 失败的 error 上挂着完整 env(含 token)。整个对象序列化过去就是泄露。
    const e = Object.assign(new Error('spawn failed'), { env: { SECRET: 'hunter2' }, stack: 'at ...' })
    const text = errorText(e)
    expect(text).toBe('spawn failed')
    expect(text).not.toContain('hunter2')
  })

  it('errorText 接得住不是 Error 的东西', () => {
    expect(errorText('plain')).toBe('plain')
    expect(errorText({ a: 1 })).toBe('{"a":1}')
    expect(errorText(undefined)).toBe('undefined')
    const circular: any = {}; circular.self = circular
    expect(() => errorText(circular)).not.toThrow()
  })
})
