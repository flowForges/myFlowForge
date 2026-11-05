import { describe, it, expect } from 'vitest'
import { expandBody as expandRaw, splitArgs, type ExpandVars } from './expand'

function expandBody(t: string, v: ExpandVars): string {
  const r = expandRaw(t, v)
  if (!r.ok) throw new Error(r.error)
  return r.text
}

const v = (o: Partial<ExpandVars> = {}): ExpandVars => ({ root: '/store/p/abc', settings: new Map(), sensitive: new Set(), ...o })

describe('expandBody', () => {
  it('$ARGUMENTS, $1, named', () => {
    expect(expandBody('run $ARGUMENTS now', v({ args: 'a b' }))).toBe('run a b now')
    expect(expandBody('first $1 second $2 third $3', v({ args: 'a "b c"' }))).toBe('first a second b c third ')
    expect(expandBody('file=$file n=$n other=$other', v({ args: 'x.txt 5', argNames: ['file', 'n'] }))).toBe('file=x.txt n=5 other=$other')
  })

  it('no placeholder: arguments are appended', () => {
    expect(expandBody('do it', v({ args: 'extra' }))).toBe('do it\n\nARGUMENTS: extra')
    expect(expandBody('do it', v())).toBe('do it')
    expect(expandBody('do it', v({ args: '  ' }))).toBe('do it')
  })

  it('a $ in args is not expanded again', () => {
    expect(expandBody('A=$1 B=$2', v({ args: '"$2" real' }))).toBe('A=$2 B=real')
    expect(expandBody('$ARGUMENTS', v({ args: '$1 ${CLAUDE_PLUGIN_ROOT} $&' }))).toBe('$1 ${CLAUDE_PLUGIN_ROOT} $&')
  })

  it('path variables and settings', () => {
    const vars = v({ skillDir: '/store/p/abc/skills/x', settings: new Map([['mode', 'fast'], ['tok', 'SECRET']]), sensitive: new Set(['tok']) })
    expect(expandBody('${CLAUDE_PLUGIN_ROOT}/s.py ${MFF_PLUGIN_ROOT}', vars)).toBe('/store/p/abc/s.py /store/p/abc')
    expect(expandBody('${CLAUDE_SKILL_DIR}/a', vars)).toBe('/store/p/abc/skills/x/a')
    expect(expandBody('${CLAUDE_SKILL_DIR}/a', v())).toBe('${CLAUDE_SKILL_DIR}/a')
    expect(expandBody('m=${user_config.mode} t=${user_config.tok} u=${user_config.none}', vars)).toBe('m=fast t=[hidden] u=${user_config.none}')
    expect(expandBody('db=${CLAUDE_PLUGIN_DATA}/x ${MFF_PLUGIN_DATA}', vars)).toBe('db=[plugin data]/x [plugin data]')
  })

  it('shell and file markers stay literal', () => {
    expect(expandBody('run !`touch m` and @file.txt', v())).toBe('run !`touch m` and @file.txt')
  })

  it('$10, $0 and unknown variables are left', () => {
    expect(expandBody('$10 $0 ${HOME} $HOME', v({ args: 'a' }))).toBe('$10 $0 ${HOME} $HOME\n\nARGUMENTS: a')
  })

  it('splitArgs', () => {
    expect(splitArgs(` a  "b c" 'd e'f "" `)).toEqual(['a', 'b c', 'd ef', ''])
  })
})
