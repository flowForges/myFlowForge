// 渲染时的没有说明文字守卫(08 §6.4、R6):每个页面任务把自己页面的行加进 noHintRender.test.tsx
const BANNED_CLASS = ['hint', 'desc', 'help', 'note', 'tip', 'caption']
const BANNED_TAG = ['P', 'SMALL']
/** 模型写的回答(app 的 Message 渲染的 Markdown)是第三方内容,不是界面文字:它的段落就是 <p>。mffai 源码不许用这两个类名(扫描规则 answer-class) */
const THIRD_PARTY = '.msg.ai .msg-body.ans'

export interface HintFinding { tag: string; className: string; text: string }

export function findHints(root: ParentNode = document.body): HintFinding[] {
  const out: HintFinding[] = []
  for (const el of root.querySelectorAll('*')) {
    if (el.closest(THIRD_PARTY)) continue
    const cls = typeof el.className === 'string' ? el.className : el.getAttribute('class') ?? ''
    const lower = cls.toLowerCase()
    if (BANNED_TAG.includes(el.tagName) || BANNED_CLASS.some((b) => lower.includes(b))) {
      out.push({ tag: el.tagName.toLowerCase(), className: cls, text: (el.textContent ?? '').slice(0, 60) })
    }
  }
  return out
}
