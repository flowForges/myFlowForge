import { describe, it, expect } from 'vitest'
import { describeHostState } from './hostView'

describe('describeHostState', () => {
  it('本机和未连接是两回事,不能显示成同一句', () => {
    // 「本机」= 你就在用这台;「未连接」= 你选了一台远程但它没连上。混成一句话
    // 会让人以为自己在看远程,其实看的是本机的数据。
    // 卡片标题已经写着「本机」,副标题不该再写一遍(真机截图里就是「本机 / 本机」两行)。
    expect(describeHostState({ status: 'local' }).text).toContain('当前看到的都是这台电脑')
    expect(describeHostState({ status: 'closed' }).text).toBe('未连接')
    expect(describeHostState({ status: 'local' }).text).not.toBe(describeHostState({ status: 'closed' }).text)
  })

  it('断线中必须说出来还要多久重连 —— 不能拿缓存假装在线', () => {
    const d = describeHostState({ status: 'retrying', attempt: 2, error: '连接断开(1006)', nextInMs: 4000 })
    expect(d.tone).toBe('bad')
    expect(d.text).toContain('已断开')
    expect(d.text).toContain('4 秒')
    expect(d.text).toContain('1006')
  })

  it('重试第几次要露出来,不然看起来像卡住了', () => {
    expect(describeHostState({ status: 'connecting', attempt: 1 }).text).toBe('连接中…')
    expect(describeHostState({ status: 'connecting', attempt: 3 }).text).toContain('第 3 次')
  })

  it('连上了要带对方版本号(版本不一致时的置灰要有个解释)', () => {
    const d = describeHostState({ status: 'ready', version: '1.1.2', methods: [] })
    expect(d).toEqual({ text: '已连接 · 1.1.2', tone: 'ok' })
  })

  it('失败要原样带上原因,别吞成一句「失败」', () => {
    const d = describeHostState({ status: 'failed', error: '主版本不兼容(对方 2.0.0,本机 1.1.2)' })
    expect(d.tone).toBe('bad')
    expect(d.text).toContain('主版本不兼容')
  })
})
