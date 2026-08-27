import { describe, it, expect } from 'vitest'
import { continueList, insertedNewlineAt } from './listContinue'

/**
 * 用 `|` 标光标:`typed('1. 买牛奶|')` = 输入框里是 `1. 买牛奶`、光标在末尾,这时按了回车。
 * 手机端拿到的是**换行已经插进去之后**的那份正文(见 listContinue.ts 文件头),所以这里
 * 自己把那个换行插好,再喂给 `continueList`。
 */
function typed(withCaret: string) {
  const pos = withCaret.indexOf('|')
  const prev = withCaret.replace('|', '')
  const next = prev.slice(0, pos) + '\n' + prev.slice(pos)
  // 第三个参数就是输入框报上来的「改动之前的光标位置」—— 见 insertedNewlineAt 的注释,
  // 少了它,插在连续换行里的位置是分不出来的。
  return continueList(prev, next, pos)
}
/** 把结果画回「带 `|` 的正文」,断言才读得懂。 */
function show(r: { text: string; caret: number } | null): string | null {
  return r ? r.text.slice(0, r.caret) + '|' + r.text.slice(r.caret) : null
}

describe('continueList', () => {
  it('★有序列表:编号自己 +1(用户原话「我输入 1. 下一个就是 2.」)', () => {
    expect(show(typed('1. 买牛奶|'))).toBe('1. 买牛奶\n2. |')
    expect(show(typed('3. 第三条|'))).toBe('3. 第三条\n4. |')
    // 9 → 10 是两位数,拼字符串的写法在这里会露馅
    expect(show(typed('9. a|'))).toBe('9. a\n10. |')
  })

  it('`)` 也是有序列表的分隔符,原样保留(别统一成 `.`)', () => {
    expect(show(typed('1) a|'))).toBe('1) a\n2) |')
  })

  it('无序列表:项目符号原样重复,三种符号都认', () => {
    expect(show(typed('- foo|'))).toBe('- foo\n- |')
    expect(show(typed('* foo|'))).toBe('* foo\n* |')
    expect(show(typed('+ foo|'))).toBe('+ foo\n+ |')
  })

  it('复选框列表续出来的是**没勾**的空盒子 —— 替人标成已完成是撒谎', () => {
    expect(show(typed('- [x] 已做|'))).toBe('- [x] 已做\n- [ ] |')
    expect(show(typed('- [ ] 待办|'))).toBe('- [ ] 待办\n- [ ] |')
  })

  it('★缩进原样带过去(嵌套列表不许被拉回顶格)', () => {
    expect(show(typed('  - a|'))).toBe('  - a\n  - |')
    expect(show(typed('    2. x|'))).toBe('    2. x\n    3. |')
    // 标记后面打了两个空格的,下一行也是两个 —— 对齐是人自己排的,不该被改
    expect(show(typed('-  a|'))).toBe('-  a\n-  |')
  })

  it('★空项上回车 = 结束列表:标记被抹掉,不再多一个空项目符号', () => {
    expect(show(typed('1. |'))).toBe('|')
    expect(show(typed('- |'))).toBe('|')
    expect(show(typed('- [ ] |'))).toBe('|')
    // 前面还有内容时,结束的只是这一行
    expect(show(typed('- a\n- |'))).toBe('- a\n|')
  })

  it('空项在正文中间时,留下一个空行,后面的内容一个字不动', () => {
    expect(show(typed('a\n2. |\nb'))).toBe('a\n|\nb')
  })

  it('多行正文里只看光标所在那一行', () => {
    expect(show(typed('开头\n1. one|'))).toBe('开头\n1. one\n2. |')
  })

  it('★在列表项中间回车:后半截跟着新标记走,不许被当成空项抹掉', () => {
    expect(show(typed('1. ab|cd'))).toBe('1. ab\n2. |cd')
    expect(show(typed('1. |买牛奶'))).toBe('1. \n2. |买牛奶')
  })

  it('普通行只是换行:返回 null,调用方原样写回去', () => {
    expect(typed('随便一句话|')).toBeNull()
    expect(typed('|')).toBeNull()
    expect(typed('第一行\n第二行|')).toBeNull()
    // 「1.」后面没有空格的不是列表(版本号 `1.2` 常见),别自作主张
    expect(typed('1.2|')).toBeNull()
  })

  it('★不是「插入了一个换行」的改动一概不管(听写/粘贴/纠错都会整段替换正文)', () => {
    // 整段替换
    expect(continueList('1. a', '这是听写出来的一大段话', 4)).toBeNull()
    // 普通打字(插入的不是换行)
    expect(continueList('1. a', '1. ab', 4)).toBeNull()
    // 删除
    expect(continueList('1. ab', '1. a', 5)).toBeNull()
    // 一次插两个换行(不是一下回车)
    expect(continueList('1. a', '1. a\n\n', 4)).toBeNull()
    // ★同一拍里既改了字又加了换行(联想/纠错就是这样整段替换的):长度刚好多一个,
    //  但**前缀**或**后缀**对不上 —— 两头都得验,只验一头就会把它当成回车。
    expect(continueList('- a', '- b\n', 3)).toBeNull()
    expect(continueList('- a', '- \nx', 2)).toBeNull()
  })

  it('★光标提示对不上时退回「从左边数第一个不一样的地方」,宁可不续也不能乱改', () => {
    // 提示是上一拍的陈旧值(指到 0)。退路选到末尾那个换行 —— 结果照样是对的。
    expect(show(continueList('1. a', '1. a\n', 0))).toBe('1. a\n2. |')
    // 一样陈旧,但这次落在「列表行末尾 + 后面还有内容」的歧义上:退路会选到后一个位置,
    // 于是判成「不是列表行」什么都不做。少续一次,总好过把 b 那一行改掉。
    expect(continueList('a\n2. \nb', 'a\n2. \n\nb', 0)).toBeNull()
    // 完全不给提示(调用方还没拿到过 selection)也是同一条退路。
    expect(show(continueList('- a', '- a\n'))).toBe('- a\n- |')
  })
})

describe('insertedNewlineAt', () => {
  it('在末尾插的换行', () => {
    expect(insertedNewlineAt('ab', 'ab\n', 2)).toBe(2)
  })
  it('在中间插的换行', () => {
    expect(insertedNewlineAt('ab', 'a\nb', 1)).toBe(1)
  })
  it('★连续换行里的位置**只能**靠光标提示分辨(两个位置拼出来的正文一模一样)', () => {
    // 同一份 next,提示不同 → 答案就得不同,否则续列表和「在空行上回车」必错一个。
    expect(insertedNewlineAt('a\n2. \nb', 'a\n2. \n\nb', 5)).toBe(5)
    expect(insertedNewlineAt('a\n2. \nb', 'a\n2. \n\nb', 6)).toBe(6)
  })
  it('提示指到一个根本拼不出 next 的位置时,退回从左边数第一个不一样的地方', () => {
    expect(insertedNewlineAt('a\n2. \nb', 'a\n2. \n\nb', 0)).toBe(6)
  })
  it('长度对不上、插的不是换行、右半截对不上,都返回 null', () => {
    expect(insertedNewlineAt('ab', 'ab', 2)).toBeNull()
    expect(insertedNewlineAt('ab', 'axb', 1)).toBeNull()
    expect(insertedNewlineAt('abc', 'a\nxc', 1)).toBeNull()
  })
})
