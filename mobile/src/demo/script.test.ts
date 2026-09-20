import { describe, it, expect } from 'vitest'
import { DEMO_FALLBACK, DEMO_REPLIES, normalize, pickReply, replyFor } from './script'

describe('体验模式剧本', () => {
  it('★条目够多 —— 少于这个数,随便问两句就全是兜底,体验模式就白做了', () => {
    // 刹车:用户要的是「几十个对话和答复」。删条目要是刻意的决定,不是顺手。
    expect(DEMO_REPLIES.length).toBeGreaterThanOrEqual(28)
  })

  it('关键词命中', () => {
    expect(pickReply('权限门是什么')?.keys).toContain('权限')
    expect(pickReply('帮我跑一下测试')?.keys).toContain('测试')
    expect(pickReply('Hello')?.keys).toContain('hello')
  })

  it('★标点和空格不影响匹配 —— 人打字带不带句号是随机的', () => {
    expect(pickReply('你好！')).toBe(pickReply('你好'))
    expect(pickReply('  这是什么?  ')?.keys).toContain('这是什么')
  })

  it('★★打分按关键词长度 —— 短词会在长句里到处命中', () => {
    // 「怎么连我自己的电脑」同时含「连接」相关的短词和「连我自己的」这条更具体的。
    expect(pickReply('怎么连我自己的电脑')?.keys).toContain('连我自己的')
  })

  it('★没命中就兜底,绝不瞎编', () => {
    expect(pickReply('阿巴阿巴巴巴巴')).toBeNull()
    expect(replyFor('阿巴阿巴巴巴巴').text).toBe(DEMO_FALLBACK)
  })

  it('★兜底必须说清「这是体验模式」—— 装成答上来了才是最坏的结果', () => {
    expect(DEMO_FALLBACK).toContain('体验模式')
    expect(DEMO_FALLBACK).toContain('离线')
  })

  it('空输入不算命中', () => {
    expect(pickReply('')).toBeNull()
    expect(pickReply('   ')).toBeNull()
  })

  it('★★剧本里不许出现真实凭据或真实路径 —— 它会被打进每个安装包,等于公开发布', () => {
    const all = JSON.stringify(DEMO_REPLIES) + DEMO_FALLBACK
    expect(all).not.toMatch(/\/Users\/[a-z]/i)
    expect(all).not.toMatch(/ghp_|sk-[a-zA-Z0-9]{8}|AuthKey_/)
    expect(all).not.toMatch(/wzcu\.com|hotmail|@qq\.com/)
  })

  it('每条都得有正文,关键词不许为空', () => {
    for (const r of DEMO_REPLIES) {
      expect(r.text.trim().length, JSON.stringify(r.keys)).toBeGreaterThan(10)
      expect(r.keys.length, r.text.slice(0, 20)).toBeGreaterThan(0)
      for (const k of r.keys) expect(normalize(k).length, k).toBeGreaterThan(0)
    }
  })

  it('★关键词不许重复 —— 两条抢同一个词时谁赢取决于数组顺序,那是意外不是设计', () => {
    const seen = new Map<string, string[]>()
    for (const r of DEMO_REPLIES) {
      for (const k of r.keys) {
        const n = normalize(k)
        const prev = seen.get(n)
        expect(prev, `「${k}」同时属于 ${JSON.stringify(prev)} 和 ${JSON.stringify(r.keys)}`).toBeUndefined()
        seen.set(n, r.keys)
      }
    }
  })
})
