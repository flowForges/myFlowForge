// 渲染时的没有说明文字守卫(08 §6.4、R6):每个页面任务把自己页面的行加进 noHintRender.test.tsx
const BANNED_CLASS = ['hint', 'desc', 'help', 'note', 'tip', 'caption']
const BANNED_TAG = ['P', 'SMALL']

export interface HintFinding { tag: string; className: string; text: string }

export function findHints(root: ParentNode = document.body): HintFinding[] {
  const out: HintFinding[] = []
  for (const el of root.querySelectorAll('*')) {
    const cls = typeof el.className === 'string' ? el.className : el.getAttribute('class') ?? ''
    const lower = cls.toLowerCase()
    if (BANNED_TAG.includes(el.tagName) || BANNED_CLASS.some((b) => lower.includes(b))) {
      out.push({ tag: el.tagName.toLowerCase(), className: cls, text: (el.textContent ?? '').slice(0, 60) })
    }
  }
  return out
}
