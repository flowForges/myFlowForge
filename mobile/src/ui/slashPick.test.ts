import { describe, it, expect } from 'vitest'
import { filterCommands, isSlashQuery, slashRows, type SlashCommand } from './slashPick'

const cmds: SlashCommand[] = [
  { cmd: '/analyst', title: 'analyst', desc: '需求分析', template: '/analyst ', kind: 'command' },
  { cmd: '/pr-review', title: 'pr-review', desc: '', template: '/pr-review ', kind: 'command' },
  { cmd: '/写作技巧', title: '写作技巧', desc: '润色中文', template: '请使用「写作技巧」技能来完成:\n', kind: 'skill' },
]

describe('isSlashQuery', () => {
  it('只打了一个斜杠就算在挑命令', () => {
    expect(isSlashQuery('/')).toBe(true)
  })

  it('打到一半也算', () => {
    expect(isSlashQuery('/ana')).toBe(true)
  })

  it('★空格一出现就不算了 —— 那之后人在写参数,不是在挑命令', () => {
    expect(isSlashQuery('/analyst 看一下登录流程')).toBe(false)
  })

  it('★换行也算空白(手机上多行输入很常见)', () => {
    expect(isSlashQuery('/analyst\n')).toBe(false)
  })

  it('不是以斜杠开头的一律不算', () => {
    expect(isSlashQuery('看看 /usr/bin 下面有什么')).toBe(false)
  })

  it('★斜杠在一段话中间不算 —— 路径里的斜杠不该弹面板', () => {
    // ★这一条**必须不带空白**:带了空白的例子(`cd /usr`)会被 `!/\s/` 那一半挡掉,
    //  于是「开头」这条规则本身一点覆盖都没有 —— 把 `startsWith` 换成 `includes` 照样全绿。
    //  (第一版就是这么写的,变异测试当场把它抓出来了。)
    expect(isSlashQuery('src/ui/copy.ts')).toBe(false)
  })

  it('空串不算', () => {
    expect(isSlashQuery('')).toBe(false)
  })
})

describe('filterCommands', () => {
  it('只打了一个斜杠 = 全都给', () => {
    expect(filterCommands(cmds, '/').map((c) => c.cmd)).toEqual(['/analyst', '/pr-review', '/写作技巧'])
  })

  it('按命令名过滤', () => {
    expect(filterCommands(cmds, '/ana').map((c) => c.cmd)).toEqual(['/analyst'])
  })

  it('★是「包含」不是「开头」—— 带前缀的命令名只记得住后半截也要搜得到', () => {
    expect(filterCommands(cmds, '/review').map((c) => c.cmd)).toEqual(['/pr-review'])
  })

  it('不分大小写', () => {
    expect(filterCommands(cmds, '/ANALYST').map((c) => c.cmd)).toEqual(['/analyst'])
  })

  it('中文命令名照样匹配', () => {
    expect(filterCommands(cmds, '/写作').map((c) => c.cmd)).toEqual(['/写作技巧'])
  })

  it('一条都不命中就是空的(调用方据此不摆面板)', () => {
    expect(filterCommands(cmds, '/zzzz')).toEqual([])
  })

  it('★不改原数组:面板每次渲染都要过一遍这里', () => {
    const out = filterCommands(cmds, '/')
    out.pop()
    expect(cmds).toHaveLength(3)
  })
})

describe('slashRows', () => {
  const on = { supported: true, dismissed: false }

  it('正常情况:开着面板,给过滤后的那几条', () => {
    expect(slashRows(cmds, '/ana', on).map((c) => c.cmd)).toEqual(['/analyst'])
  })

  it('★★主机没有 commands:list 这个方法时一条都不给 —— 空面板会让人以为「我一条命令都没有」', () => {
    expect(slashRows(cmds, '/', { supported: false, dismissed: false })).toEqual([])
  })

  it('★选过一条之后收起来,哪怕正文还是个光秃秃的斜杠命令', () => {
    expect(slashRows(cmds, '/analyst', { supported: true, dismissed: true })).toEqual([])
  })

  it('★正文已经不是斜杠查询了就不摆(打了空格开始写参数)', () => {
    // ★用**只多一个空格**的 `/analyst ` 而不是 `/analyst 看一下`:后者去掉斜杠再 trim 之后是
    //  「analyst 看一下」,本来就一条都匹配不上 —— 于是「要不要看 isSlashQuery」这条规则
    //  一点覆盖都没有,把那一半判据整个删掉照样全绿(变异测试抓到的)。
    //  `/analyst ` 才是分水岭:trim 之后正好是 `analyst`,不看 isSlashQuery 就会**匹配上**。
    expect(slashRows(cmds, '/analyst ', on)).toEqual([])
    expect(slashRows(cmds, '/analyst 看一下', on)).toEqual([])
  })

  it('主机上一条命令都没有时也是空的', () => {
    expect(slashRows([], '/', on)).toEqual([])
  })
})
