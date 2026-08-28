import { describe, it, expect } from 'vitest'
import { ROUTES } from './routes'

describe('路由字符串', () => {
  it('每一条都是绝对路径', () => {
    for (const [k, v] of Object.entries(ROUTES)) expect(v, k).toMatch(/^\//)
  })

  it('★★分组名绝不许漏进路由字符串里', () => {
    // expo-router 的 `(tabs)` 是**分组**,不进 URL —— `/index` 才是对的,`/(tabs)/index` 不是。
    // 写错了不会报错:router.replace('/(tabs)/index') 只是静默什么也不做,
    // 而 goBack() 的兜底正是靠它 —— 症状是「没有返回栈时点返回,屏幕一动不动」。
    for (const [k, v] of Object.entries(ROUTES)) expect(v, k).not.toContain('(')
  })

  it('首页是根', () => {
    expect(ROUTES.home).toBe('/')
  })

  it('三个 tab 都在,且互不相同', () => {
    const tabs = [ROUTES.home, ROUTES.hosts, ROUTES.settings]
    expect(new Set(tabs).size).toBe(3)
  })

  it('没有重复的目标 —— 两个名字指同一个屏,迟早有人只改其中一个', () => {
    const vals = Object.values(ROUTES)
    expect(new Set(vals).size).toBe(vals.length)
  })
})
