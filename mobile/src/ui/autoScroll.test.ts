import { describe, it, expect } from 'vitest'
import { atBottom, initialAutoScroll, nextScroll, type FlowShape } from './autoScroll'

/** 一串「消息流长什么样」喂进去,收回每一步滚不滚。默认贴着底(人没动过)。 */
const run = (steps: (Partial<FlowShape> & { count: number })[]) => {
  let s = initialAutoScroll()
  return steps.map((x) => {
    const r = nextScroll(s, { tail: 0, atBottom: true, ...x })
    s = r.state
    return r.scroll
  })
}

describe('autoScroll', () => {
  it('★进屏那一次(0 → N)瞬间到位,不带动画', () => {
    expect(run([{ count: 0 }, { count: 12, tail: 5 }])).toEqual([false, { animated: false }])
  })

  it('之后来的新消息才带动画', () => {
    expect(run([{ count: 0 }, { count: 12, tail: 5 }, { count: 13, tail: 1 }, { count: 14, tail: 2 }])).toEqual([
      false,
      { animated: false },
      { animated: true },
      { animated: true },
    ])
  })

  it('一条消息都没有时不滚 —— 空会话滚一下会闪', () => {
    expect(run([{ count: 0 }, { count: 0 }])).toEqual([false, false])
  })

  it('★换会话(被清回 0)之后,新会话的首帧重新变成「瞬间到位」', () => {
    expect(run([{ count: 0 }, { count: 12, tail: 5 }, { count: 13, tail: 3 }, { count: 0 }, { count: 40, tail: 9 }])).toEqual([
      false,
      { animated: false },
      { animated: true },
      false,
      { animated: false },
    ])
  })

  it('条数和末条长度都没变就不重复滚(重渲染不该把人从上面拽到底下)', () => {
    expect(run([{ count: 0 }, { count: 12, tail: 5 }, { count: 12, tail: 5 }])).toEqual([
      false,
      { animated: false },
      false,
    ])
  })

  // ── 这一轮真正要治的病 ────────────────────────────────────────────────────────
  it('★★正文在长、条数不变(流式吐字)也要跟着滚 —— 用户原话「LLM 一直输出,页面应该一直滚动」', () => {
    expect(
      run([
        { count: 0 },
        { count: 4, tail: 0 },     // assistant-start:空壳先落下
        { count: 4, tail: 30 },    // delta
        { count: 4, tail: 61 },    // delta
        { count: 4, tail: 118 },   // delta
      ]),
    ).toEqual([false, { animated: false }, { animated: true }, { animated: true }, { animated: true }])
  })

  it('★正文被整段替换成更短的一段(assistant-replace)也算变了,照样跟', () => {
    expect(run([{ count: 0 }, { count: 4, tail: 200 }, { count: 4, tail: 12 }])).toEqual([
      false,
      { animated: false },
      { animated: true },
    ])
  })

  it('★★人往上翻了就停止跟随 —— 内容还在长,但一下都不许滚', () => {
    expect(
      run([
        { count: 0 },
        { count: 4, tail: 10 },
        { count: 4, tail: 40, atBottom: false },
        { count: 4, tail: 90, atBottom: false },
        { count: 5, tail: 3, atBottom: false },   // 连新消息都不许把他拽回去
      ]),
    ).toEqual([false, { animated: false }, false, false, false])
  })

  it('★人滑回底部之后,下一片新内容就恢复跟随', () => {
    expect(
      run([
        { count: 0 },
        { count: 4, tail: 10 },
        { count: 4, tail: 40, atBottom: false },
        { count: 4, tail: 70, atBottom: true },
      ]),
    ).toEqual([false, { animated: false }, false, { animated: true }])
  })

  it('★离开底部期间不攒「欠账」:回到底部后是接着当前内容跟,不是补一次追赶', () => {
    // 离开期间 tail 从 10 涨到 500;回来后这一片只涨到 501 —— 仍然只滚这一次,
    // 而且是普通的带动画滚动(不是「瞬间到位」那种补课)。
    expect(
      run([
        { count: 0 },
        { count: 4, tail: 10 },
        { count: 4, tail: 500, atBottom: false },
        { count: 4, tail: 501, atBottom: true },
      ]),
    ).toEqual([false, { animated: false }, false, { animated: true }])
  })

  it('★★滑回底部这件事**本身**不许跳一下 —— 离开期间长出来的内容已经记过账了', () => {
    // 这一条钉的是「离开底部时状态照样往前推」。不推的话,人一滑回底部、下一次重渲染
    // 就会拿离开前那份旧长度去比,判成「内容变了」,当场补一次跳到底 —— 他刚停在那儿要读的地方
    // 就这么没了。
    expect(
      run([
        { count: 0 },
        { count: 4, tail: 10 },
        { count: 4, tail: 500, atBottom: false },
        { count: 4, tail: 500, atBottom: true },
      ]),
    ).toEqual([false, { animated: false }, false, false])
  })

  it('★★首帧不受 atBottom 影响:内容比一屏高时它一开始就是假,不许因此吃掉「进屏落到最后一条」', () => {
    expect(run([{ count: 0 }, { count: 30, tail: 40, atBottom: false }])).toEqual([false, { animated: false }])
  })
})

describe('atBottom', () => {
  // ★这里的数字**全部写死**,不引用 BOTTOM_SLACK:拿常量去断言常量,常量一改断言跟着改,
  //  等于什么都没钉住(把 24 改成 9999 也照样绿)。
  it('正好贴底 = 真', () => {
    expect(atBottom({ contentH: 1000, offsetY: 400, viewH: 600 })).toBe(true)
  })

  it('差 24pt 仍算贴底 —— 橡皮筋回弹和像素取整就在这个量级', () => {
    expect(atBottom({ contentH: 1024, offsetY: 400, viewH: 600 })).toBe(true)
  })

  it('★差 25pt 就算离开了(余量的上界钉死在 24)', () => {
    expect(atBottom({ contentH: 1025, offsetY: 400, viewH: 600 })).toBe(false)
  })

  it('往上翻了一屏 = 假', () => {
    expect(atBottom({ contentH: 3000, offsetY: 400, viewH: 600 })).toBe(false)
  })

  it('内容比视口还短(整屏装得下)= 真 —— 这种会话根本没得滚', () => {
    expect(atBottom({ contentH: 200, offsetY: 0, viewH: 600 })).toBe(true)
  })
})
