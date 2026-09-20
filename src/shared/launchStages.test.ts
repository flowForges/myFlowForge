import { describe, it, expect } from 'vitest'
import { stageAllowsPerProject, isPerProjectStage, stageAllowsAgentPick, buildStageChoice } from './launchStages'

/**
 * 这几条判定电脑端和手机端**必须是同一份**。走偏的后果在界面上看不出来:
 * 给「代码开发」发一个 `perProject: false`,`buildLaunchPlan` 会照办、把它的逐项目扇出压成单代理,
 * 屏幕上只显示「跑了一个 lane」—— 没人看得出错在哪。
 */

const code = { code: true }                       // 代码开发
const doc = { code: false, producesDoc: true }    // 技术方案
const plain = { code: false }                     // 写单测 / 代码 CR

describe('哪些阶段能切「单代理 ⇄ 按项目」', () => {
  it('★代码开发不能切 —— 它本来就是按项目扇出的,给开关等于允许关掉它', () => {
    expect(stageAllowsPerProject(code)).toBe(false)
  })
  it('★技术方案不能切 —— 按项目跑会变成 N 份互相打架的方案', () => {
    expect(stageAllowsPerProject(doc)).toBe(false)
  })
  it('写单测 / 代码 CR 可以切', () => {
    expect(stageAllowsPerProject(plain)).toBe(true)
  })
})

describe('这次运行里到底按不按项目扇出', () => {
  it('代码开发:不管开关怎么摆,永远按项目', () => {
    expect(isPerProjectStage(code, false)).toBe(true)
    expect(isPerProjectStage(code, true)).toBe(true)
  })
  it('可切的阶段:听开关的', () => {
    expect(isPerProjectStage(plain, false)).toBe(false)
    expect(isPerProjectStage(plain, true)).toBe(true)
  })
  it('★技术方案:开关就算被拨到 true 也不算 —— 它压根不该有那个开关', () => {
    expect(isPerProjectStage(doc, true)).toBe(false)
  })
})

describe('哪些阶段能逐阶段挑代理', () => {
  it('★代码开发不行 —— 它的代理来自逐项目那组选择器,两个地方说同一件事必然对不上', () => {
    expect(stageAllowsAgentPick(code)).toBe(false)
  })
  it('其余都行', () => {
    expect(stageAllowsAgentPick(doc)).toBe(true)
    expect(stageAllowsAgentPick(plain)).toBe(true)
  })
})

describe('组装发给服务端的那一项', () => {
  const st = { enabled: true, provider: 'claude', model: 'opus', perProject: true }

  it('★★不可切的阶段**不带** perProject —— 带了会把逐项目扇出压成单代理', () => {
    expect(buildStageChoice({ ...code, key: 'develop' }, st)).not.toHaveProperty('perProject')
    expect(buildStageChoice({ ...doc, key: 'design' }, st)).not.toHaveProperty('perProject')
  })

  it('可切的阶段带上开关的值', () => {
    expect(buildStageChoice({ ...plain, key: 'test' }, st).perProject).toBe(true)
    expect(buildStageChoice({ ...plain, key: 'test' }, { ...st, perProject: false }).perProject).toBe(false)
  })

  it('阶段级项目代理:没改过就不带,让主进程回落到工作区那份', () => {
    expect(buildStageChoice({ ...plain, key: 'test' }, st)).not.toHaveProperty('projects')
    expect(buildStageChoice({ ...plain, key: 'test' }, st, [])).not.toHaveProperty('projects')
  })

  it('改过就带上', () => {
    const c = buildStageChoice({ ...plain, key: 'test' }, st, [{ name: 'api', provider: 'codex', model: 'gpt-5' }])
    expect(c.projects).toEqual([{ name: 'api', provider: 'codex', model: 'gpt-5' }])
  })

  it('开关关掉的阶段照样要发出去 —— 服务端靠 enabled:false 把它从计划里丢掉', () => {
    const c = buildStageChoice({ ...plain, key: 'test' }, { ...st, enabled: false })
    expect(c.enabled).toBe(false)
    expect(c.key).toBe('test')
  })
})
