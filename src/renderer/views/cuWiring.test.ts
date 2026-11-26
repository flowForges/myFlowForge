import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, 'WorkspaceView.tsx'), 'utf8')

describe('WorkspaceView computer-use wiring (source scan)', () => {
  it('the hook is idle while the window views a remote host, and the card tail gets the same flag', () => {
    expect(src).toMatch(/const cuRemote = cuHost\.key !== 'local' \|\| !cuHost\.known/)
    expect(src).toMatch(/useComputerUse\(cuRemote \? '' :/)
    expect(src).toMatch(/<CuStreamTail remote=\{cuRemote\}/)
  })
  it('rc3: the per-turn log blocks are woven into the stream (local only), open by default only for the running turn', () => {
    expect(src).toMatch(/weaveCuTurns\(liveWindow\.visible, cuRemote \? \[\] : groupCuTurns\(cu\.log, cuUserTs\(liveWindow\.visible\)\), liveWindow\.hiddenCount\)/)
    expect(src).toMatch(/entry\.kind === 'cu-turn'/)
    expect(src).toMatch(/const dflt = entry\.latest && chat\.busy/)
    expect(src).not.toMatch(/log=\{cu\.log\}/)
  })
  it('the composer chip gets remote, refreshStatus (no status call on mount) and the settings opener', () => {
    expect(src).toMatch(/computerUse=\{\{[\s\S]*remote: cuRemote[\s\S]*refreshStatus: cu\.refreshStatus[\s\S]*openSettings/)
  })
})
