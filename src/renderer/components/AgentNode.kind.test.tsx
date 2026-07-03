import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AgentNode } from './AgentNode'

describe('AgentNode kind classes', () => {
  it('applies the k-file class on a log line tagged kind:file', () => {
    render(
      <AgentNode
        open
        onToggle={() => {}}
        agent={{
          id: 'a1', name: 'Coder', role: '写代码', provider: 'claude', model: 'sonnet',
          state: 'run',
          logs: [{ ts: '09:42:01', text: '修改 src/x.ts', level: 'accent', kind: 'file' }],
        }}
      />
    )
    const line = screen.getByText('修改 src/x.ts').closest('.log-line')
    expect(line).not.toBeNull()
    expect(line!.className).toContain('k-file')
  })
})
