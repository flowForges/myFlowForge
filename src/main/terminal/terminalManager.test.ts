import { describe, it, expect, vi } from 'vitest'
import { TerminalManager, type PtyLike } from './terminalManager'

function fakePty(): PtyLike & { _data?:(d:string)=>void; _exit?:(e:any)=>void; killed:boolean } {
  const o:any = { killed:false, pid:4242,
    onData:(cb:any)=>{o._data=cb}, onExit:(cb:any)=>{o._exit=cb},
    write:vi.fn(), resize:vi.fn(), kill:vi.fn(()=>{o.killed=true}) }
  return o
}

describe('TerminalManager', () => {
  const mk = (over:any={}) => {
    const spawn = vi.fn(() => fakePty())
    const onData = vi.fn(); const onExit = vi.fn()
    const m = new TerminalManager({ spawn, onData, onExit, env: { SHELL:'/bin/zsh' }, exists:()=>true, ...over })
    return { m, spawn, onData, onExit }
  }
  it('spawns the resolved login shell with TERM/COLORTERM env on create', () => {
    const { m, spawn } = mk()
    m.create({ termId:'t1', cwd:'/x', cols:80, rows:24 })
    expect(spawn).toHaveBeenCalledWith('/bin/zsh', ['-l'], expect.objectContaining({
      cwd:'/x', cols:80, rows:24,
      env: expect.objectContaining({ TERM:'xterm-256color', COLORTERM:'truecolor', FORGE_TERMINAL:'1' }),
    }))
    expect(m.size()).toBe(1); expect(m.has('t1')).toBe(true); expect(m.pidOf('t1')).toBe(4242)
  })
  it('forwards pty data/exit to callbacks with the termId', () => {
    const { m, spawn, onData, onExit } = mk()
    m.create({ termId:'t1', cwd:'/x', cols:80, rows:24 })
    const pty:any = spawn.mock.results[0].value
    pty._data('hello'); expect(onData).toHaveBeenCalledWith('t1','hello')
    pty._exit({ exitCode:0 }); expect(onExit).toHaveBeenCalledWith('t1', { exitCode:0 })
    expect(m.has('t1')).toBe(false)   // exit removes it
  })
  it('write/resize/kill proxy to the right pty; kill removes it', () => {
    const { m, spawn } = mk()
    m.create({ termId:'t1', cwd:'/x', cols:80, rows:24 })
    const pty:any = spawn.mock.results[0].value
    m.write('t1','ls\n'); expect(pty.write).toHaveBeenCalledWith('ls\n')
    m.resize('t1', 100, 30); expect(pty.resize).toHaveBeenCalledWith(100, 30)
    m.kill('t1'); expect(pty.kill).toHaveBeenCalled(); expect(m.has('t1')).toBe(false)
  })
  it('enforces the concurrency cap', () => {
    const { m } = mk({ cap: 2 })
    m.create({ termId:'a', cwd:'/', cols:80, rows:24 })
    m.create({ termId:'b', cwd:'/', cols:80, rows:24 })
    expect(() => m.create({ termId:'c', cwd:'/', cols:80, rows:24 })).toThrow('TERM_CAP')
  })
  it('killAll kills every pty', () => {
    const { m, spawn } = mk()
    m.create({ termId:'a', cwd:'/', cols:80, rows:24 })
    m.create({ termId:'b', cwd:'/', cols:80, rows:24 })
    m.killAll()
    expect(spawn.mock.results.every((r:any)=>r.value.killed)).toBe(true)
    expect(m.size()).toBe(0)
  })
})
