import { describe, it, expect, vi } from 'vitest'
import { useState as reactUseState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { Composer } from './Composer'
import type { ProviderInfo } from '@shared/types'

const providers: ProviderInfo[] = [{ id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus', label: 'opus' }] } as unknown as ProviderInfo]
const ta = () => screen.getByPlaceholderText(/给主代理下达任务/) as HTMLTextAreaElement

// Reproduces WorkspaceView's seed wiring: a seed (workflow trigger phrase) held in PARENT state, passed to
// a Composer that is remounted per session (key={draftKey}). The seed must be consumed ONCE and never
// re-injected into the next session on remount (the "workflow prompt stuck in another session's box" bug).
function Harness() {
  const [sid, setSid] = reactUseState('A')
  const [seed, setSeed] = reactUseState<{ text: string; nonce: number } | undefined>(undefined)
  return (
    <div>
      <button onClick={() => setSeed({ text: '开启「重构」工作流,按以下需求分阶段执行:', nonce: 1 })}>seed</button>
      <button onClick={() => setSid('B')}>switchB</button>
      <button onClick={() => setSid('A')}>switchA</button>
      <Composer
        key={`c ${sid}`}
        draftKey={`ws ${sid}`}
        providers={providers}
        disabled={false}
        onSend={vi.fn()}
        seedText={seed}
        onSeedConsumed={() => setSeed(undefined)}
      />
    </div>
  )
}

describe('Composer seed (workflow trigger phrase) is consume-once', () => {
  it('injects into the seeding session but does NOT leak into the next session on switch', () => {
    render(<Harness />)
    expect(ta().value).toBe('')
    fireEvent.click(screen.getByText('seed'))
    expect(ta().value).toBe('开启「重构」工作流,按以下需求分阶段执行:')
    // Switch to session B → Composer remounts. The seed was already consumed, so B opens EMPTY.
    fireEvent.click(screen.getByText('switchB'))
    expect(ta().value).toBe('')
  })
})
