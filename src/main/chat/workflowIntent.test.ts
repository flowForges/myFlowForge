import { describe, expect, it } from 'vitest'
import { isWorkflowIntent, isResumeIntent } from './workflowIntent'

describe('isWorkflowIntent', () => {
  it('detects explicit workflow execution requests', () => {
    expect(isWorkflowIntent('请按照工作流的方式执行这个需求')).toBe(true)
    expect(isWorkflowIntent('跑工作流实现登录')).toBe(true)
    expect(isWorkflowIntent('按流程执行并完成开发')).toBe(true)
  })

  it('detects colloquial "开启/打开/启用工作流" phrasings', () => {
    expect(isWorkflowIntent('开启工作流，我要做个功能')).toBe(true)
    expect(isWorkflowIntent('打开工作流')).toBe(true)
    expect(isWorkflowIntent('启用工作流开始开发')).toBe(true)
  })

  it('does not classify ordinary questions as workflow intent', () => {
    expect(isWorkflowIntent('这个项目结构是什么')).toBe(false)
    expect(isWorkflowIntent('工作流配置在哪里')).toBe(false)
  })

  it('detects 「工作流的形式/模式」 phrasings, not just 「方式」', () => {
    expect(isWorkflowIntent('设计方案，用工作流的形式')).toBe(true)
    expect(isWorkflowIntent('用工作流形式推进')).toBe(true)
    expect(isWorkflowIntent('工作流模式执行')).toBe(true)
    expect(isWorkflowIntent('按工作流的模式来')).toBe(true)
  })

  it('detects 「用工作流 / 以工作流」 phrasings', () => {
    expect(isWorkflowIntent('用工作流做')).toBe(true)
    expect(isWorkflowIntent('以工作流推进')).toBe(true)
    expect(isWorkflowIntent('这个需求用工作流实现')).toBe(true)
  })

  it('does NOT match negated 「不用/不要用/别用工作流」', () => {
    expect(isWorkflowIntent('不用工作流')).toBe(false)
    expect(isWorkflowIntent('不要用工作流')).toBe(false)
    expect(isWorkflowIntent('别用工作流')).toBe(false)
    expect(isWorkflowIntent('这次先不用工作流，直接聊')).toBe(false)
  })

  it('does NOT match negated 「使用/采用」 variants either', () => {
    expect(isWorkflowIntent('不要使用工作流')).toBe(false)
    expect(isWorkflowIntent('别使用工作流')).toBe(false)
    expect(isWorkflowIntent('不使用工作流')).toBe(false)
    expect(isWorkflowIntent('不采用工作流')).toBe(false)
    expect(isWorkflowIntent('无需使用工作流')).toBe(false)
    expect(isWorkflowIntent('不能用工作流')).toBe(false)
    expect(isWorkflowIntent('没必要用工作流')).toBe(false)
  })

  it('still matches affirmative 「使用/采用工作流」', () => {
    expect(isWorkflowIntent('使用工作流来做这个需求')).toBe(true)
    expect(isWorkflowIntent('采用工作流推进')).toBe(true)
  })
})

describe('isResumeIntent', () => {
  it('detects explicit continue/resume phrasings', () => {
    expect(isResumeIntent('继续吧，刚才不小心取消了')).toBe(true)
    expect(isResumeIntent('继续执行')).toBe(true)
    expect(isResumeIntent('接着跑')).toBe(true)
    expect(isResumeIntent('从上次继续')).toBe(true)
    expect(isResumeIntent('继续工作流')).toBe(true)
  })

  it('detects "往后/接着往后" phrasings that are not the literal word 继续', () => {
    expect(isResumeIntent('往后执行')).toBe(true)
    expect(isResumeIntent('能接着之前往后做么')).toBe(true)
    expect(isResumeIntent('接着往后执行')).toBe(true)
    expect(isResumeIntent('往下做')).toBe(true)
    expect(isResumeIntent('继续往后推进')).toBe(true)
  })

  it('does not classify unrelated messages as resume intent', () => {
    expect(isResumeIntent('这个需求怎么设计')).toBe(false)
    expect(isResumeIntent('取消运行')).toBe(false)
    expect(isResumeIntent('')).toBe(false)
    expect(isResumeIntent('往后的规划是什么')).toBe(false)
  })
})
