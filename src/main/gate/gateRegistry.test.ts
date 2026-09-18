import { describe, it, expect, vi } from 'vitest'
import { createGateRegistry, AUTO_POLICY } from './gateRegistry'

const CTX = { origin: 'setup' as const, workspacePath: '/ws', sessionId: 's1', label: '建区 Hook · 装 skill' }

describe('门总线', () => {
  it('升起来的门在 list() 里,答了就不在了', async () => {
    const r = createGateRegistry()
    const p = r.raise(CTX, { title: 'Bash 请求执行', where: 'npm i' })
    const [g] = r.list()
    expect(g?.title).toBe('Bash 请求执行')
    expect(g?.label, '来源要能说清是谁在等').toBe('建区 Hook · 装 skill')
    expect(r.resolve(g!.id, 'allow')).toBe(true)
    await expect(p).resolves.toBe('allow')
    expect(r.list()).toEqual([])
  })

  /**
   * ★★这条是整个文件存在的理由。建区那条路以前**没有快照** —— 模态框一关(`App.tsx` 把 state
   *  重置掉),那道门就再也没有 UI 能答,而主进程那边的 Promise 不超时也不兜底,于是界面永远
   *  停在「运行中」。有 list() 之后,任何界面随时都能把还挂着的门重建出来。
   */
  it('★★门的存活不依赖任何一个界面 —— 关掉再打开,它还在', async () => {
    const r = createGateRegistry()
    const p = r.raise(CTX, { title: '等你放行' })
    // 「界面没了」在这一层就是「没人订阅了」
    const off = r.subscribe(() => {})
    off()
    const again = r.list({ workspacePath: '/ws' })
    expect(again, '界面关掉不该带走门').toHaveLength(1)
    r.resolve(again[0]!.id, 'deny')
    await expect(p).resolves.toBe('deny')
  })

  it('重复回答只算第一次', async () => {
    const r = createGateRegistry()
    const p = r.raise(CTX, { title: 'x' })
    const id = r.list()[0]!.id
    expect(r.resolve(id, 'allow')).toBe(true)
    expect(r.resolve(id, 'deny'), '第二次没有门可答了').toBe(false)
    await expect(p).resolves.toBe('allow')
  })

  it('drain 收尾:只收匹配的那些,并且真的把 promise 解开', async () => {
    const r = createGateRegistry()
    const a = r.raise({ ...CTX, workspacePath: '/a' }, { title: 'a' })
    const b = r.raise({ ...CTX, workspacePath: '/b' }, { title: 'b' })
    expect(r.drain((g) => g.workspacePath === '/a', 'deny')).toBe(1)
    await expect(a).resolves.toBe('deny')
    expect(r.list()).toHaveLength(1)
    r.drain(() => true, 'deny')
    await expect(b).resolves.toBe('deny')
  })

  /**
   * ★不需要人答的路径也要**走一遍总线**。以前委派那条是调用点里一句
   *  `onConfirm: async () => 'deny'` —— 它的效果和「忘了接门」在界面上一模一样(都是静默),
   *  所以没人能区分「这条路故意不给门」和「这条路的门断了」。现在它是一条能被数出来的记录。
   */
  it('★自动决定的路径也发 raised + resolved,不是隐形的', async () => {
    const r = createGateRegistry()
    const seen: string[] = []
    r.subscribe((c) => seen.push(c.type))
    await expect(r.autoDecide({ origin: 'delegate', workspacePath: '/ws' }, { title: 'rm -rf' }))
      .resolves.toBe(AUTO_POLICY.delegate.decision)
    expect(seen, '一次完整的门:升起来 + 被决定').toEqual(['raised', 'resolved'])
    expect(r.list(), '自动决定的门不该留在 pending 里').toEqual([])
  })

  it('★两条自动路径的方向必须是写死并且看得见的', () => {
    // 迁移前:委派缺省 deny、工作流泳道缺省 allow —— 两个方向相反,而没有任何地方能同时看见它们。
    expect(AUTO_POLICY.delegate.decision).toBe('deny')
    expect(AUTO_POLICY.oneshot.decision).toBe('deny')
    for (const p of Object.values(AUTO_POLICY)) {
      expect(p.why.length, '每条自动决定都要说得出理由').toBeGreaterThan(5)
    }
  })

  it('一个订阅者炸了,不影响别人,也不影响升门', async () => {
    const r = createGateRegistry()
    const good = vi.fn()
    r.subscribe(() => { throw new Error('订阅者自己的 bug') })
    r.subscribe(good)
    const p = r.raise(CTX, { title: 'x' })
    expect(good).toHaveBeenCalled()
    r.resolve(r.list()[0]!.id, 'allow')
    await expect(p).resolves.toBe('allow')
  })

  it('按工作区 / 来源 / 会话过滤', () => {
    const r = createGateRegistry()
    void r.raise({ origin: 'setup', workspacePath: '/a', sessionId: 's1' }, { title: '1' })
    void r.raise({ origin: 'chat', workspacePath: '/a', sessionId: 's2' }, { title: '2' })
    void r.raise({ origin: 'chat', workspacePath: '/b' }, { title: '3' })
    expect(r.list({ workspacePath: '/a' })).toHaveLength(2)
    expect(r.list({ origin: 'chat' })).toHaveLength(2)
    expect(r.list({ workspacePath: '/a', sessionId: 's2' })).toHaveLength(1)
  })
})
