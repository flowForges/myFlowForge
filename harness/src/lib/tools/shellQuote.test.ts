import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { shellQuote } from './shellQuote'

// 真的过一遍 /bin/sh -c:`printf '%s\0'` 把每个参数原样打出来,NUL 分隔
function roundTrip(args: string[]): string[] {
  const out = execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${shellQuote(args)}`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
  return out.split('\0').slice(0, -1)
}

describe.skipIf(process.platform === 'win32')('shellQuote', () => {
  it.each([
    ['spaces', 'a b  c'],
    ['single quote', "it's"],
    ['only single quotes', "'''"],
    ['double quote', 'say "hi"'],
    ['dollar', '$HOME $(touch /nope) `touch /nope`'],
    ['newline', 'a\nb\n'],
    ['leading dash', '--dangerously-skip-permissions'],
    ['backslash', 'a\\b\\'],
    ['glob and tilde', '~/* ? [a]'],
    ['operators', 'a; b && c | d > e &'],
    ['unicode', '提示词 🙂'],
    ['empty', ''],
  ])('%s survives /bin/sh -c', (_name, arg) => {
    expect(roundTrip(['x', arg, 'y'])).toEqual(['x', arg, 'y'])
  })

  it('a quoted first word is a command, never an assignment or a keyword', () => {
    expect(shellQuote(['A=1', 'if'])).toBe("'A=1' 'if'")
  })

  it('refuses a NUL: the shell would cut the string there', () => {
    expect(() => shellQuote(['a\0b'])).toThrow(/NUL/)
  })
})
