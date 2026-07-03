import { describe, it, expect } from 'vitest'
import { SettingsSchema, WorkflowSchema, WorkspaceSchema, defaultSettings, STAGE_KEYS } from './schema'
import { STAGE_PROMPTS, WsStageSchema } from './schema'

describe('pet states + pos (P3-4)', () => {
  it('defaults pos.bottom and all five states when absent (back-compat)', () => {
    // an old pet block with no pos/states still parses
    const old = { enabled: true, skin: 'sprite', corner: 'right', notify: { confirm: true, input: true, done: false } }
    const s = SettingsSchema.parse({ ...defaultSettings(), pet: old })
    expect(s.pet.pos).toEqual({ bottom: 24 })
    expect(s.pet.states.confirm).toEqual({ anim: 'alert', accent: 'warn' })
    expect(s.pet.states.idle).toEqual({ anim: 'float', accent: 'none' })
    expect(s.pet.states.input).toEqual({ anim: 'tilt', accent: 'accent' })
    expect(s.pet.states.done).toEqual({ anim: 'pulse-ok', accent: 'ok' })
    expect(s.pet.states.working).toEqual({ anim: 'spin-halo', accent: 'none' })
  })
  it('rejects an unknown anim', () => {
    const bad = { ...defaultSettings().pet, states: { ...defaultSettings().pet.states, idle: { anim: 'wiggle', accent: 'none' } } }
    expect(() => SettingsSchema.parse({ ...defaultSettings(), pet: bad })).toThrow()
  })
  it('接受新增的 4 种 anim', () => {
    for (const anim of ['jelly', 'glow-breathe', 'sparkle', 'flip']) {
      const pet = { ...defaultSettings().pet, states: { ...defaultSettings().pet.states, idle: { anim, accent: 'none' } } }
      expect(() => SettingsSchema.parse({ ...defaultSettings(), pet })).not.toThrow()
    }
  })
})

describe('pet free position (free-drag)', () => {
  it('accepts a pet config with free: {x, y}', () => {
    const s = SettingsSchema.parse({ ...defaultSettings(), pet: { ...defaultSettings().pet, free: { x: 120, y: 80 } } })
    expect(s.pet.free).toEqual({ x: 120, y: 80 })
  })
  it('parses legacy configs without free (backward compat, free stays undefined)', () => {
    const s = SettingsSchema.parse({ ...defaultSettings(), pet: { ...defaultSettings().pet } })
    expect(s.pet.free).toBeUndefined()
  })
})

describe('config schema', () => {
  it('provides valid default settings', () => {
    expect(() => SettingsSchema.parse(defaultSettings())).not.toThrow()
    // 新用户默认亮色主题(2026-07-02 起);已有 settings.json 的用户不受影响。
    expect(defaultSettings().appearance.theme).toBe('light')
    expect(defaultSettings().termProxy).toBe('')
  })
  it('rejects an unknown theme', () => {
    expect(() => SettingsSchema.parse({ ...defaultSettings(), appearance: { ...defaultSettings().appearance, theme: 'neon' } })).toThrow()
  })
  it('accent defaults to blue and accepts the 7 schemes', () => {
    expect(SettingsSchema.parse(defaultSettings()).appearance.accent).toBe('blue')
    for (const a of ['blue','violet','emerald','amber','rose','cyan','graphite']) {
      expect(() => SettingsSchema.parse({ ...defaultSettings(), appearance: { ...defaultSettings().appearance, accent: a } })).not.toThrow()
    }
    expect(() => SettingsSchema.parse({ ...defaultSettings(), appearance: { ...defaultSettings().appearance, accent: 'neon' } })).toThrow()
  })
  it('validates a standard workflow with ordered stages', () => {
    const wf = { id: 'std', name: '标准工作流', stages: STAGE_KEYS.map(k => ({ key: k, defaultAgent: 'claude', defaultModel: 'opus-4.8' })) }
    expect(() => WorkflowSchema.parse(wf)).not.toThrow()
  })
})

describe('WorkspaceSchema (SP-A: resolved config)', () => {
  it('parses the new shape with resolved stages + enriched projects', () => {
    const ws = WorkspaceSchema.parse({
      name: 'demo', path: '/tmp/demo', workflowId: 'standard',
      stages: [{ key: 'develop', provider: 'claude', model: 'opus-4.8' }],
      projects: [{ repoId: 'p', name: 'p', branch: 'main', provider: 'codex', model: 'gpt-5-codex' }],
      status: 'idle'
    })
    expect(ws.stages).toEqual([{ key: 'develop', provider: 'claude', model: 'opus-4.8' }])
    expect(ws.projects[0]).toEqual({ repoId: 'p', name: 'p', branch: 'main', provider: 'codex', model: 'gpt-5-codex' })
  })

  it('parses the OLD shape (no stages, projects only {repoId,branch}) with defaults (back-compat)', () => {
    const ws = WorkspaceSchema.parse({
      name: 'old', path: '/tmp/old', workflowId: 'standard',
      projects: [{ repoId: 'p', branch: 'main' }], status: 'idle'
    })
    expect(ws.stages).toEqual([])
    expect(ws.projects[0]).toEqual({ repoId: 'p', name: '', branch: 'main', provider: '', model: '' })
  })

  it('rejects an unknown stage key', () => {
    expect(() => WorkspaceSchema.parse({
      name: 'x', path: '/tmp/x', workflowId: 'standard',
      stages: [{ key: 'bogus', provider: 'claude', model: 'm' }],
      projects: [], status: 'idle'
    })).toThrow()
  })
})

describe('STAGE_PROMPTS', () => {
  it('每个 stage key 都有非空内置默认正文', () => {
    for (const k of STAGE_KEYS) expect(STAGE_PROMPTS[k].length).toBeGreaterThan(0)
  })
})

describe('schema 追加段字段', () => {
  it('WorkflowSchema.stagePrompts 缺省补空对象', () => {
    const wf = WorkflowSchema.parse({ id: 'w', name: 'W', stages: [{ key: 'develop', defaultAgent: 'claude', defaultModel: 'opus-4.8' }] })
    expect(wf.stagePrompts).toEqual({})
  })
  it('WorkflowSchema.stagePrompts 保留覆盖', () => {
    const wf = WorkflowSchema.parse({ id: 'w', name: 'W', stages: [{ key: 'design', defaultAgent: 'claude', defaultModel: 'opus-4.8' }], stagePrompts: { design: '要画时序图' } })
    expect(wf.stagePrompts.design).toBe('要画时序图')
  })
  it('WsStageSchema.prompt 可选', () => {
    const s = WsStageSchema.parse({ key: 'design', provider: 'claude', model: 'opus-4.8', prompt: '附加' })
    expect(s.prompt).toBe('附加')
    expect(WsStageSchema.parse({ key: 'design', provider: 'claude', model: 'opus-4.8' }).prompt).toBeUndefined()
  })
})
