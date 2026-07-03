import type { AgentRuntime } from '@shared/types'
import { HOOK_SKILLS, HOOK_TOOLS } from '@shared/plugin'
import './hookNode.css'

const STATE_MAP: Record<string, { cls: string; label: string }> = {
  wait: { cls: 'st-wait', label: '等待' },
  run:  { cls: 'st-run',  label: '执行中' },
  stalled:  { cls: 'st-stalled',  label: '疑似卡住' },
  awaiting: { cls: 'st-awaiting', label: '等待确认' },
  ok:   { cls: 'st-ok',   label: '完成' },
  err:  { cls: 'st-err',  label: '失败' },
}

// puzzle icon path from prototype (index.html line 3100)
const PUZZLE_PATH = 'M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.6 2.6 0 0 1 0 5.2H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.6 2.6 0 0 1 5.2 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z'

interface HookNodeProps {
  agent: AgentRuntime
  open: boolean
  onToggle: () => void
}

export function HookNode({ agent, open, onToggle }: HookNodeProps) {
  const stateInfo = STATE_MAP[agent.state] ?? STATE_MAP.wait
  const isWait = agent.state === 'wait'
  const isRun = agent.state === 'run'

  // Resolve skill display names from HOOK_SKILLS catalog
  const skillCaps = (agent.hookSkills ?? []).map(id => {
    const item = HOOK_SKILLS.find(s => s.id === id)
    return item ? { id, name: item.name } : null
  }).filter(Boolean) as { id: string; name: string }[]

  // Resolve tool display names from HOOK_TOOLS catalog
  const toolCaps = (agent.hookTools ?? []).map(id => {
    const item = HOOK_TOOLS.find(t => t.id === id)
    return item ? { id, name: item.name } : null
  }).filter(Boolean) as { id: string; name: string }[]

  const hasCaps = skillCaps.length > 0 || toolCaps.length > 0

  // Output logs: filter to output kind or show all if no kinds present
  const outputLogs = agent.logs.filter(l => !l.kind || l.kind === 'output')
  const shownLogs = isRun ? outputLogs.slice(0, 1) : outputLogs

  return (
    <div className={`hook-node ${agent.state}`} data-hook={agent.id}>
      {/* Header — 点击折叠/展开 */}
      <div className="hook-head" role="button" tabIndex={0} onClick={onToggle}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}>
        <span className="hook-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d={PUZZLE_PATH} />
          </svg>
        </span>
        <span className="hook-meta">
          <span className="hook-name">
            {agent.name}
            <span className="hook-kind">插件 · HOOK</span>
          </span>
          <span className="hook-when">{agent.role}</span>
        </span>
        <span className={`hook-state ${stateInfo.cls}`}>
          <span className="d" />
          {stateInfo.label}
        </span>
      </div>

      {/* 能力徽章(折叠时隐藏) */}
      {open && hasCaps && (
        <div className="hook-caps">
          {skillCaps.length > 0 && (
            <>
              <span className="hk-cap-lab">技能</span>
              {skillCaps.map(s => (
                <span key={s.id} className="hk-cap s">
                  <span className="hk-b s">S</span>
                  {s.name}
                </span>
              ))}
            </>
          )}
          {toolCaps.length > 0 && (
            <>
              <span className="hk-cap-lab">工具</span>
              {toolCaps.map(t => (
                <span key={t.id} className="hk-cap t">
                  <span className="hk-b t">T</span>
                  {t.name}
                </span>
              ))}
            </>
          )}
        </div>
      )}

      {/* 产出/等待正文(折叠时隐藏) */}
      {open && (
        <div className="hook-out">
          <div className="hook-out-h">
            <span className="od" />
            产出{isRun ? ' · 执行中' : ''}
          </div>
          {isWait ? (
            <div className="hook-wait-note">等待前序阶段完成后注入并执行</div>
          ) : (
            <>
              {shownLogs.map((l, i) => (
                <div key={i} className={`hook-oline${l.level === 'ok' ? ' ok' : ''}`}>
                  <span className="ot">›</span>
                  <span className="ox">
                    {l.text}
                    {isRun && i === shownLogs.length - 1 && <span className="log-cursor" />}
                  </span>
                </div>
              ))}
              {agent.state === 'ok' && <div className="hook-inject">注入下一阶段上下文</div>}
            </>
          )}
        </div>
      )}
    </div>
  )
}
