import { describe, expect, it } from 'vitest'
import { isPlainCommand } from '../tools/commandKey'
import { DEFAULT_NETWORK_ALLOW, evaluate, type Effect, type MatchCtx, matches, parseRule, type Rule, type RuleError, type RuleSpec, runTests } from './rules'

const DARWIN: MatchCtx = { cwd: '/__cwd__', home: '/Users/u', platform: 'darwin' }
const LINUX: MatchCtx = { cwd: '/__cwd__', home: '/home/u', platform: 'linux' }
const WIN: MatchCtx = { cwd: 'C:\\__cwd__', home: 'C:\\Users\\u', platform: 'win32' }

const isErr = (r: Rule | RuleError): r is RuleError => 'reason' in r

function rule(effect: Effect, text: string, extra: Partial<RuleSpec> = {}): Rule {
  const r = parseRule({ effect, rule: text, ...extra })
  if (isErr(r)) throw new Error(`bad rule ${text}: ${r.reason}`)
  return r
}

describe('parseRule', () => {
  it('splits subject and pattern', () => {
    expect(rule('deny', 'shell(git push*)')).toMatchObject({ effect: 'deny', subject: 'shell', pattern: 'git push*' })
    expect(rule('allow', 'read(~/work/lib/**)')).toMatchObject({ subject: 'read', pattern: '~/work/lib/**' })
    expect(rule('ask', 'write(package.json)').spec).toEqual({ effect: 'ask', rule: 'write(package.json)' })
  })

  it.each<[Effect, string, RuleError['reason']]>([
    ['deny', 'shell(', 'syntax'],
    ['deny', 'shell', 'syntax'],
    ['deny', 'read(x)y', 'syntax'],
    ['deny', 'shell(echo $(x)', 'syntax'],
    ['deny', 'shell(a))', 'syntax'],
    ['deny', 'Shell(x)', 'subject'],
    ['deny', 'edit(x)', 'subject'],
    ['deny', 'exec(x)', 'subject'],
    ['allow', 'shell(*)', 'pattern'],
    ['allow', 'shell( *x)', 'pattern'],
    ['deny', 'read()', 'pattern'],
    ['deny', 'shell(   )', 'pattern'],
    ['deny', 'read(a/../b)', 'pattern'],
    ['deny', 'write(../x)', 'pattern'],
    ['deny', 'read(a\0b)', 'pattern'],
    ['deny', 'shell(a\0b)', 'pattern'],
  ])('%s %j → %s', (effect, text, reason) => {
    expect(parseRule({ effect, rule: text }, 3)).toEqual({ index: 3, rule: text, reason })
  })

  it.each<[string, unknown]>([
    ['match', 'git push'],
    ['match', [1]],
    ['noMatch', { a: 'x' }],
    ['noMatch', ['ok', null]],
  ])('rejects non-string-array %s %j as syntax instead of throwing', (key, value) => {
    const spec = { effect: 'deny', rule: 'shell(git push*)', [key]: value } as unknown as RuleSpec
    expect(parseRule(spec, 2)).toEqual({ index: 2, rule: 'shell(git push*)', reason: 'syntax' })
  })

  it('rejects an unknown effect as syntax', () => {
    expect(parseRule({ effect: 'permit' as Effect, rule: 'read(x)' })).toMatchObject({ reason: 'syntax' })
  })

  it('accepts balanced parens inside a command pattern and deny shell(*)', () => {
    expect(rule('deny', 'shell(echo $(date))').pattern).toBe('echo $(date)')
    expect(rule('deny', 'shell(*)').pattern).toBe('*')
  })
})

describe('matches: shell', () => {
  it.each([
    ['git push', true],
    ['git push -f origin', true],
    ['ls && git push', true],
    ['ls || git push', true],
    ['ls; git push', true],
    ['ls | git push', true],
    ['sleep 1 & git push', true],
    ['ls\ngit push', true],
    ['FOO=1 git push', true],
    ['FOO="a b" BAR=2 git push', true],
    ['env FOO=1 git push', true],
    ['env -i git push', true],
    ['command git push', true],
    ['exec git push', true],
    ['echo $(git push)', true],
    ['echo `git push`', true],
    ['(git push)', true],
    ['  git   push\t ', true],
    ['git pushd', true],
    ['if git push; then git status; fi', true],
    ['if true; then git push; fi', true],
    ['for x in a; do git push; done', true],
    ['while true; do git push; done', true],
    ['until git push; do :; done', true],
    ['if false; then :; elif git push; then :; fi', true],
    ['if false; then :; else git push; fi', true],
    ['{ git push; }', true],
    ['! git push', true],
    ['time git push', true],
    ['time -p git push', true],
    ['env -u HOME git push', true],
    ['env --unset HOME -i - FOO=1 git push', true],
    ['env -C /tmp git push', true],
    ['exec -a name git push', true],
    ['if env -u X time -p git push; then :; fi', true],
    ['git status', false],
    ['echo git push', false],
    ['echo if git push', false],
  ])('deny shell(git push*) also hits `git pushd`, because `*` is a raw glob: %j → %s', (cmd, want) => {
    expect(matches(rule('deny', 'shell(git push*)'), cmd, LINUX)).toBe(want)
  })

  it.each([
    ['npm test', true],
    ['  npm   test ', true],
    ['npm test; rm -rf x', false],
    ['npm test && rm -rf x', false],
    ['ls && npm test', false],
    ['FOO=1 npm test', false],
    ['npm test2', false],
  ])('allow shell(npm test) only matches the whole plain command: %j → %s', (cmd, want) => {
    expect(matches(rule('allow', 'shell(npm test)'), cmd, LINUX)).toBe(want)
  })

  it('allow with * still requires a plain command', () => {
    const r = rule('allow', 'shell(npm run *)')
    expect(matches(r, 'npm run build', LINUX)).toBe(true)
    expect(matches(r, 'npm run build $(curl x)', LINUX)).toBe(false)
    expect(matches(r, 'npm run %PATH%', WIN)).toBe(false)
    expect(matches(r, 'npm run "x"', LINUX)).toBe(false)
  })

  it('ask matches segments like deny', () => {
    expect(matches(rule('ask', 'shell(rm -rf *)'), 'cd x && rm -rf build', LINUX)).toBe(true)
  })

  it('compares commands literally (no case folding, ? is literal)', () => {
    expect(matches(rule('deny', 'shell(git push*)'), 'GIT PUSH', DARWIN)).toBe(false)
    expect(matches(rule('deny', 'shell(a?c)'), 'abc', LINUX)).toBe(false)
    expect(matches(rule('deny', 'shell(a?c)'), 'a?c', LINUX)).toBe(true)
  })

  it('runs in polynomial time on adversarial patterns', () => {
    const r = rule('deny', `shell(${'*a'.repeat(30)}*b)`)
    const t = Date.now()
    expect(matches(r, 'a'.repeat(5000), LINUX)).toBe(false)
    expect(Date.now() - t).toBeLessThan(2000)
  })
})

describe('matches: paths', () => {
  it.each([
    ['/__cwd__/src', true],
    ['/__cwd__/src/a/b.ts', true],
    ['/__cwd__/srcx', false],
    ['/__cwd__/srcx/a', false],
    ['/__cwd__/lib/src/a', false],
    ['/elsewhere/src/a', false],
  ])('write(src/**) %s → %s', (p, want) => {
    expect(matches(rule('allow', 'write(src/**)'), p, LINUX)).toBe(want)
  })

  it('~/ patterns resolve against home', () => {
    const r = rule('deny', 'read(~/.aws/**)')
    expect(matches(r, '/home/u/.aws/credentials', LINUX)).toBe(true)
    expect(matches(r, '/home/u/.aws', LINUX)).toBe(true)
    expect(matches(r, '/home/u/.awsx', LINUX)).toBe(false)
    expect(matches(r, '/__cwd__/.aws/credentials', LINUX)).toBe(false)
    expect(matches(rule('deny', 'read(~)'), '/home/u', LINUX)).toBe(true)
  })

  it('darwin folds case for every effect; linux does not', () => {
    for (const effect of ['deny', 'ask', 'allow'] as const) {
      expect(matches(rule(effect, 'write(src/**)'), '/__cwd__/SRC/a', DARWIN)).toBe(true)
      expect(matches(rule(effect, 'write(SRC/**)'), '/__cwd__/src/a', DARWIN)).toBe(true)
      expect(matches(rule(effect, 'write(src/**)'), '/__cwd__/SRC/a', LINUX)).toBe(false)
    }
  })

  it('strong fold only for deny / ask: ſ hits deny but not allow', () => {
    expect(matches(rule('deny', 'write(src/**)'), '/__cwd__/ſrc/a', DARWIN)).toBe(true)
    expect(matches(rule('ask', 'write(src/**)'), '/__cwd__/ſrc/a', DARWIN)).toBe(true)
    expect(matches(rule('allow', 'write(src/**)'), '/__cwd__/ſrc/a', DARWIN)).toBe(false)
    expect(matches(rule('deny', 'read(~/straße/**)'), '/Users/u/STRASSE/x', DARWIN)).toBe(true)
    // `?` is one character under the weak fold: deny still hits `ß`
    expect(matches(rule('deny', 'read(a?c)'), '/__cwd__/aßc', DARWIN)).toBe(true)
  })

  it('a trailing / means /**', () => {
    const r = rule('deny', 'read(build/)')
    expect(matches(r, '/__cwd__/build', LINUX)).toBe(true)
    expect(matches(r, '/__cwd__/build/x/y', LINUX)).toBe(true)
    expect(matches(r, '/__cwd__/buildx', LINUX)).toBe(false)
  })

  it('* stays within a segment, ? is one char, ** spans levels', () => {
    expect(matches(rule('deny', 'read(*.env)'), '/__cwd__/.env', LINUX)).toBe(true)
    expect(matches(rule('deny', 'read(*.env)'), '/__cwd__/a/.env', LINUX)).toBe(false)
    expect(matches(rule('deny', 'read(**/*.env)'), '/__cwd__/a/b/x.env', LINUX)).toBe(true)
    expect(matches(rule('deny', 'read(a?.ts)'), '/__cwd__/ab.ts', LINUX)).toBe(true)
    expect(matches(rule('deny', 'read(a?.ts)'), '/__cwd__/a/.ts', LINUX)).toBe(false)
    expect(matches(rule('deny', 'read([ab].ts)'), '/__cwd__/[ab].ts', LINUX)).toBe(true)
    expect(matches(rule('deny', 'read([ab].ts)'), '/__cwd__/a.ts', LINUX)).toBe(false)
    expect(matches(rule('deny', 'read(./src/./a)'), '/__cwd__/src/a', LINUX)).toBe(true)
  })

  it('absolute patterns, and the absolute prefix goes through realpath', () => {
    expect(matches(rule('allow', 'read(/opt/lib/**)'), '/opt/lib/a.h', LINUX)).toBe(true)
    const realpath = (p: string) => {
      if (p === '/var' || p.startsWith('/var/')) return `/private${p}`
      if (p === '/' || p === '/private') return p
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    const ctx = { ...DARWIN, realpath }
    const r = rule('allow', 'read(/var/data/**/*.json)')
    expect(matches(r, '/private/var/data/x/a.json', ctx)).toBe(true)
    expect(matches(r, '/var/data/x/a.json', ctx)).toBe(true)
    expect(matches(r, '/private/var/data/x/a.txt', ctx)).toBe(false)
    // cwd under /var resolves as well
    expect(matches(rule('allow', 'write(src/**)'), '/private/var/w/src/a', { ...ctx, cwd: '/var/w' })).toBe(true)
  })

  it('win32: drive-letter patterns with either slash, case-insensitive', () => {
    expect(matches(rule('allow', 'read(C:/libs/**)'), 'C:\\libs\\a\\b.h', WIN)).toBe(true)
    expect(matches(rule('allow', 'read(c:\\Libs\\**)'), 'C:\\libs\\a', WIN)).toBe(true)
    expect(matches(rule('allow', 'write(src/**)'), 'C:\\__cwd__\\SRC\\a.ts', WIN)).toBe(true)
    expect(matches(rule('allow', 'read(~/x/**)'), 'C:\\Users\\u\\x\\y', WIN)).toBe(true)
    expect(matches(rule('allow', 'read(~\\x\\**)'), 'C:\\Users\\u\\x\\y', WIN)).toBe(true)
    expect(matches(rule('allow', 'write(src/**)'), 'D:\\__cwd__\\src\\a.ts', WIN)).toBe(false)
    const seen: string[] = []
    const realpath = (p: string) => (seen.push(p), p)
    expect(matches(rule('allow', 'read(C:/*/x)'), 'C:\\a\\x', { ...WIN, realpath })).toBe(true)
    expect(seen).toEqual(['C:\\'])
  })

  it('a resource that is not a comparable path hits deny / ask but never allow', () => {
    expect(matches(rule('deny', 'read(src/**)'), '\0mffai:outside', LINUX)).toBe(true)
    expect(matches(rule('allow', 'read(**)'), '\0mffai:outside', LINUX)).toBe(false)
    expect(matches(rule('allow', 'read(**)'), 'relative/x', LINUX)).toBe(false)
  })
})

describe('runTests', () => {
  it('passes when match / noMatch hold, with the fake cwd and real home', () => {
    const r = rule('deny', 'write(src/gen/**)', { match: ['src/gen/a.ts', '/__cwd__/src/gen'], noMatch: ['src/a.ts', '~/src/gen/a.ts'] })
    expect(runTests(r, { ...LINUX, cwd: '/real/project' })).toBeUndefined()
    const h = rule('allow', 'read(~/work/lib/**)', { match: ['~/work/lib/a.ts'], noMatch: ['work/lib/a.ts'] })
    expect(runTests(h, LINUX)).toBeUndefined()
    const s = rule('deny', 'shell(git push*)', { match: ['git push origin main'], noMatch: ['git status'] })
    expect(runTests(s, LINUX)).toBeUndefined()
  })

  it('uses C:\\__cwd__ on win32', () => {
    const r = rule('allow', 'write(src/**)', { match: ['src\\a.ts', 'C:\\__cwd__\\src'] })
    expect(runTests(r, { ...WIN, cwd: 'D:\\x' })).toBeUndefined()
  })

  it('reports the first failing case', () => {
    const bad = rule('deny', 'shell(git push*)', { match: ['git push', 'git status'] })
    expect(runTests(bad, LINUX, 4)).toEqual({ index: 4, rule: 'shell(git push*)', reason: 'test_failed', case: 'git status' })
    const bad2 = rule('allow', 'write(src/**)', { match: ['src/a'], noMatch: ['src/b'] })
    expect(runTests(bad2, LINUX)).toEqual({ index: 0, rule: 'write(src/**)', reason: 'test_failed', case: 'src/b' })
  })
})

describe('evaluate', () => {
  const rules = [
    rule('allow', 'write(src/**)'),
    rule('ask', 'write(src/gen/**)'),
    rule('deny', 'write(src/gen/secret/**)'),
    rule('allow', 'read(/opt/**)'),
    rule('deny', 'shell(git push*)'),
    rule('allow', 'shell(npm test)'),
  ]
  it.each<['read' | 'write' | 'exec', string, Effect | undefined]>([
    ['write', '/__cwd__/src/a.ts', 'allow'],
    ['write', '/__cwd__/src/gen/a.ts', 'ask'],
    ['write', '/__cwd__/src/gen/secret/k', 'deny'],
    ['read', '/__cwd__/src/a.ts', undefined],
    ['write', '/opt/x', undefined],
    ['read', '/opt/x', 'allow'],
    ['exec', 'npm test', 'allow'],
    ['exec', 'npm test && git push', 'deny'],
    ['exec', 'ls', undefined],
  ])('%s %s → %s', (action, resource, want) => {
    expect(evaluate(rules, { action, resource }, LINUX)).toBe(want)
  })

  it('deny > ask > allow regardless of order', () => {
    const order = [rule('deny', 'read(a/**)'), rule('allow', 'read(a/**)'), rule('ask', 'read(a/**)')]
    expect(evaluate(order, { action: 'read', resource: '/__cwd__/a/x' }, LINUX)).toBe('deny')
    expect(evaluate([...order].reverse(), { action: 'read', resource: '/__cwd__/a/x' }, LINUX)).toBe('deny')
    expect(evaluate([order[1], order[2]], { action: 'read', resource: '/__cwd__/a/x' }, LINUX)).toBe('ask')
    expect(evaluate([], { action: 'read', resource: '/__cwd__/a/x' }, LINUX)).toBeUndefined()
  })
})

describe('isPlainCommand', () => {
  it.each([
    ['npm test', true],
    ['npm run build -- --x=1', true],
    ['npm test; ls', false],
    ['echo $HOME', false],
    ['echo %PATH%', false],
    ['echo 50%', true],
    ['a\nb', false],
  ])('%j → %s', (cmd, want) => {
    expect(isPlainCommand(cmd)).toBe(want)
  })
})

it('DEFAULT_NETWORK_ALLOW holds the nine default hosts', () => {
  expect(DEFAULT_NETWORK_ALLOW).toEqual([
    'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'github.com', 'codeload.github.com',
    'objects.githubusercontent.com', 'crates.io', 'static.crates.io', 'proxy.golang.org',
  ])
})
