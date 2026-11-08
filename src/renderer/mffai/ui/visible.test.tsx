// 看不见的字符显示成 \u{…}:PText 和审批卡片用同一个 helper(Task 13 评审),输出不变
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '@testing-library/react'
import { visibleChars } from './visible'
import { PText } from './PText'
import { visibleSummary } from '../chat/ApprovalCard'

const SAMPLE = 'rm\u202E -rf\u200B x\u2028y\u00AD'

describe('visibleChars', () => {
  it('each format char and line/paragraph separator becomes a \\u{…} span; the rest stays text', () => {
    const { container } = render(<span>{visibleChars(SAMPLE)}</span>)
    expect(container.textContent).toBe('rm\\u{202E} -rf\\u{200B} x\\u{2028}y\\u{AD}')
    expect([...container.querySelectorAll('.mffai-esc')].map((n) => n.textContent)).toEqual(['\\u{202E}', '\\u{200B}', '\\u{2028}', '\\u{AD}'])
  })
  it('PText and the approval summary render the same escapes for one line', () => {
    const a = render(<PText text={SAMPLE} />).container.querySelector('.mffai-ptext')!.innerHTML
    const b = render(<pre>{visibleSummary(SAMPLE)}</pre>).container.querySelector('pre')!.innerHTML
    expect(b).toBe(a)
  })
  it('the escaping lives in one place', () => {
    for (const f of ['PText.tsx', '../chat/ApprovalCard.tsx']) {
      const src = readFileSync(join(__dirname, f), 'utf8')
      expect(src, f).not.toMatch(/\\p\{Cf\}/)
      expect(src, f).toMatch(/from '\.\/visible'|from '\.\.\/ui\/visible'/)
    }
  })
})
