import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SubagentSpinner, ThinkSpinner } from './Spinners'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RENDERER = path.resolve(HERE, '../..')

describe('两个转圈图标', () => {
  it('★★主代理和子代理**形状不同** —— 不是同一个图标换个颜色', () => {
    // 用户要求把两者区分开。靠颜色区分在小尺寸、换皮肤、色弱三种情况下都不成立,
    // 所以判据是**画的元素不同**:线条 vs 圆点。
    const think = render(<ThinkSpinner />).container
    const sub = render(<SubagentSpinner />).container
    expect(think.querySelectorAll('line').length).toBeGreaterThan(0)
    expect(think.querySelectorAll('circle').length).toBe(0)
    expect(sub.querySelectorAll('circle').length).toBeGreaterThan(0)
    expect(sub.querySelectorAll('line').length).toBe(0)
  })

  it('每一段都有自己的动画延迟 —— 全是 0 的话就是整体一起闪,不像在转', () => {
    const el = render(<ThinkSpinner />).container
    const delays = [...el.querySelectorAll('line')].map((l) => (l as SVGElement).style.animationDelay)
    expect(new Set(delays).size).toBe(delays.length)
  })

  it('尺寸可调', () => {
    const svg = render(<ThinkSpinner size={20} />).container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('20')
  })

  it('★★刹车:渲染层不许再出现那段开口圆弧', () => {
    // 2026-09-17 用户:「我甚至所有的开口圆弧都去掉」。那个路径(`a9 9 0 1 1…`)是它的指纹。
    // ★不是洁癖:它和新的两个图标混在一起时,界面上会同时有两种「在转」的语言。
    const bad: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue
        const src = fs.readFileSync(p, 'utf8')
        // 刷新按钮那种带箭头的弧(后面跟着 polyline)不算 —— 它是静态图标,不转。
        if (/a9 9 0 1 1-6\.2-8\.5/.test(src)) bad.push(path.relative(RENDERER, p))
      }
    }
    walk(RENDERER)
    expect(bad, `这些文件里还有开口圆弧 spinner:${bad.join(', ')}`).toEqual([])
  })
})
