import { describe, it, expect } from 'vitest'
import { needsConversationDoc, buildConversationDoc, CONVERSATION_DOC_REL } from './conversationDoc'

// ④(2026-08-12 用户定的方向):执行 lane 是全新的 CLI 会话,看不到任何聊天上下文 —— 它只吃
// forge-docs/*.md 和一段简短需求。跑了「技术方案设计」阶段时没问题(那一步会落 forge-docs/design.md,
// 就是跨 provider 的契约);可用户如果把方案阶段去掉、聊完直接开发,forge-docs 是空的,之前聊的全丢了。
// 兜底:这种情况下把对话本身落成一份文档,让它照样走「读整份文档」那条既有的路。
//
// 刻意不做 LLM 蒸馏:一来又要多跑一次模型、又是一次可能被截断的总结;二来用户已经定过原则——
// 文档是契约、读整份不蒸馏。原始对话啰嗦但完整,而且用户自己能打开看、能改。
const stage = (key: string, producesDoc = false) => ({ key, name: key, provider: 'x', model: 'm', scope: 'root' as const, gate: false, producesDoc })

describe('needsConversationDoc', () => {
  it('工作流里有产出文档的阶段(技术方案设计)→ 不写,那份才是契约', () => {
    expect(needsConversationDoc([stage('design', true), stage('develop')])).toBe(false)
  })

  it('用户把方案阶段去掉、聊完直接开发 → 要写,否则上下文彻底丢失', () => {
    expect(needsConversationDoc([stage('develop'), stage('review')])).toBe(true)
  })

  it('空阶段列表按不写处理(没有执行,谈不上契约)', () => {
    expect(needsConversationDoc([])).toBe(false)
  })
})

describe('buildConversationDoc', () => {
  const msgs = [
    { who: 'user', text: '把 token 迁到 OKLCH' },
    { who: 'ai', text: '好的,分三步:先抽 token,再换算,最后回归' },
  ]

  it('落成人能读的 markdown:标题 + 双方原话', () => {
    const md = buildConversationDoc(msgs)
    expect(md).toContain('# ')
    expect(md).toContain('把 token 迁到 OKLCH')
    expect(md).toContain('先抽 token')
  })

  it('标明这是对话原文而非技术方案,免得 agent 当成已定稿的方案照着做', () => {
    expect(buildConversationDoc(msgs)).toContain('对话')
  })

  it('区分双方发言,不糊成一坨', () => {
    const md = buildConversationDoc(msgs)
    expect(md).toContain('用户')
    expect(md).toContain('助手')
  })

  it('空文本的消息(启动卡这类合成消息)不进文档', () => {
    expect(buildConversationDoc([...msgs, { who: 'ai', text: '   ' }]).match(/助手/g)!.length).toBe(1)
  })

  it('过长时从尾部截断并标注(保留最近的结论)', () => {
    const md = buildConversationDoc([{ who: 'user', text: '早期AAAA' }, { who: 'user', text: '最终BBBB' }], 16)
    expect(md).toContain('最终BBBB')
    expect(md).not.toContain('早期AAAA')
    expect(md).toContain('省略')
  })

  it('一条有效消息都没有时返回空,调用方据此不写文件', () => {
    expect(buildConversationDoc([{ who: 'ai', text: '  ' }])).toBe('')
  })

  it('落盘路径与 forgeDocsDirective 扫描的目录一致', () => {
    expect(CONVERSATION_DOC_REL).toBe('forge-docs/conversation.md')
  })
})
