import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, 'WorkspaceView.tsx'), 'utf8')

describe('WorkspaceView computer-use wiring (source scan)', () => {
  it('the hook is idle while the window views a remote host, and the card tail gets the same flag', () => {
    expect(src).toMatch(/const cuRemote = useHostKey\(\) !== 'local'/)
    expect(src).toMatch(/useComputerUse\(cuRemote \? '' :/)
    expect(src).toMatch(/<CuStreamTail remote=\{cuRemote\}/)
  })
  it('the composer chip gets remote, refreshStatus (no status call on mount) and the settings opener', () => {
    expect(src).toMatch(/computerUse=\{\{[\s\S]*remote: cuRemote[\s\S]*refreshStatus: cu\.refreshStatus[\s\S]*openSettings/)
  })
})
