import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { agentIcon } from './AgentLogo'
import { AGENT_LOGO_SVG } from './agentLogos'
import { BUILTIN_PROVIDERS } from '@shared/providerCatalog'

describe('agentIcon —— 编码代理官方图标', () => {
  it('内置代理除 reasonix 外都有官方 SVG', () => {
    const missing = BUILTIN_PROVIDERS.map(p => p.id).filter(id => !AGENT_LOGO_SVG[id])
    expect(missing).toEqual(['reasonix'])
  })

  it('有图标 → 渲染 svg;没有 → 用调用方给的字符', () => {
    const { container: a } = render(<>{agentIcon('codex', '⬡')}</>)
    expect(a.querySelector('svg')).not.toBeNull()
    expect(a.textContent).not.toContain('⬡')
    const { container: b } = render(<>{agentIcon('reasonix', '∴')}</>)
    expect(b.querySelector('svg')).toBeNull()
    expect(b.textContent).toBe('∴')
  })

  it('SVG 不带写死的宽高 / title,尺寸交给 CSS', () => {
    for (const svg of Object.values(AGENT_LOGO_SVG)) {
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg).not.toMatch(/<title>|width="1em"|height="1em"/)
    }
  })
})
