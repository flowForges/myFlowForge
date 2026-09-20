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
    // 所以判据是**画的结构不同**:主代理是一张**散开**的节点网(有连线、点在四面八方),
    // 子代理是**同心**的波纹(没有一根线、所有圆共用一个圆心)。
    const think = render(<ThinkSpinner />).container
    const sub = render(<SubagentSpinner />).container

    expect(think.querySelectorAll('line').length, '主代理要有连线').toBeGreaterThan(3)
    expect(sub.querySelectorAll('line').length, '子代理一根线都不该有').toBe(0)

    const centers = new Set([...sub.querySelectorAll('circle')].map((c) => `${c.getAttribute('cx')},${c.getAttribute('cy')}`))
    expect(centers.size, '子代理的圆必须同心').toBe(1)
    const thinkCenters = new Set([...think.querySelectorAll('circle')].map((c) => `${c.getAttribute('cx')},${c.getAttribute('cy')}`))
    expect(thinkCenters.size, '主代理的点必须散开').toBeGreaterThan(4)
  })

  it('★★八拍传递:五组各有各的关键帧 —— 一级要亮两次,靠 delay 错不出来', () => {
    // 节拍是 ①中心 ②一级连线 ③一级节点 ④二级连线 ⑤二级节点 ⑥④ ⑦③ ⑧②。
    // 一级在一个周期里亮**两次**,所以它不能和别人共用一条动画再错开延迟 ——
    // 真那么写的话做出来是单向的波,不是来回传。这条断言钉住「五组分开」这件事。
    const el = render(<ThinkSpinner />).container
    for (const cls of ['sp-b0', 'sp-b1', 'sp-b2', 'sp-b3', 'sp-b4']) {
      expect(el.querySelector(`.${cls}`), `少了 ${cls} 这一组`).not.toBeNull()
    }
    const css = fs.readFileSync(path.join(HERE, 'chat.css'), 'utf8')
    for (const kf of ['sp-p0', 'sp-p1', 'sp-p2', 'sp-p3', 'sp-p4']) {
      expect(css, `${kf} 的关键帧不在 chat.css 里 —— CSS 假 class 是静默失败`).toContain(`@keyframes ${kf}`)
    }
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
