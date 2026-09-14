import { describe, it, expect } from 'vitest'
import { SITE_ORIGIN, docsUrl, DOCS_REMOTE, DOCS_RELAY, DOCS_MOBILE } from './links'

describe('对外链接', () => {
  it('域名只有一处，所有文档链接都从它派生', () => {
    for (const u of [DOCS_REMOTE, DOCS_RELAY, DOCS_MOBILE]) expect(u.startsWith(SITE_ORIGIN + '/')).toBe(true)
  })

  it('★指向 docs.html 的锚点，不是 /docs/xxx —— 官网文档是单页+侧栏锚点', () => {
    // 写成 /docs/remote 不会报错，只会 404;写错锚点也不会报错,只会静默落到页顶。
    // 这两种都表现为「点了没反应」,查起来很费劲,所以把形状钉住。
    expect(DOCS_REMOTE).toBe('https://myflowforge.wzcu.com/docs.html#remote')
    expect(DOCS_RELAY).toBe('https://myflowforge.wzcu.com/docs.html#relay')
    expect(DOCS_MOBILE).toBe('https://myflowforge.wzcu.com/docs.html#mobile')
  })

  it('不带锚点就是文档首页', () => {
    expect(docsUrl()).toBe('https://myflowforge.wzcu.com/docs.html')
  })
})
