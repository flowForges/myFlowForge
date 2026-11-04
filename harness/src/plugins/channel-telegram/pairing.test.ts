import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nullLogger } from '../../kernel/log'
import { fakeClock, type FakeClock } from '../../../test/memoryRig'
import { Pairing, parsePairCommand } from './pairing'
import { TelegramState } from './state'

const HOUR = 3_600_000
const MINUTE = 60_000
const WRONG = 'ZZZZ-ZZZZ'

describe('Pairing', () => {
  let root: string
  let clock: FakeClock
  let state: TelegramState
  let burned: number
  let pairing: Pairing

  const fresh = () => new Pairing({ state, now: clock.now, onBurned: () => burned++ })
  const seconds = () => Math.floor(clock.now() / 1000)
  /** 随机码碰巧等于 WRONG 的概率可以不管 */
  const wrong = (sender: string) => pairing.attempt(sender, WRONG, seconds())

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mffai-tg-pair-'))
    clock = fakeClock()
    state = TelegramState.open(join(root, 'tg', 'state.json'), nullLogger)
    state.data.bot = { id: 1, username: 'b' }
    burned = 0
    pairing = fresh()
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  describe('the code', () => {
    it('is 8 Crockford characters, shown with one hyphen', () => {
      for (let i = 0; i < 200; i++) expect(pairing.begin().code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    })

    it('expires in 5 minutes', () => {
      expect(pairing.begin().expiresAt).toBe(clock.now() + 5 * MINUTE)
    })

    it.each([
      ['as issued', (c: string) => c],
      ['no hyphen', (c: string) => c.replace('-', '')],
      ['lower case', (c: string) => c.toLowerCase()],
      ['stray hyphens and spaces', (c: string) => ` ${c.slice(0, 2)}-${c.slice(2, 4)} ${c.slice(5)} `],
    ])('input: %s', (_name, form) => {
      const { code } = pairing.begin()
      expect(pairing.attempt('7', form(code), seconds())).toBe('ok')
    })

    it('Crockford look-alikes read as the digit', () => {
      const { code } = pairing.begin()
      const typed = code.replace(/0/g, 'O').replace(/1/g, 'l')
      expect(pairing.attempt('7', typed, seconds())).toBe('ok')
    })

    it('neither the code nor a plain hash of it sits in the object or state', () => {
      const { code } = pairing.begin()
      const plain = code.replace('-', '')
      expect(JSON.stringify(pairing)).not.toContain(plain)
      expect(JSON.stringify(state.data)).not.toContain(plain)
    })

    it('two codes differ', () => {
      expect(pairing.begin().code).not.toBe(pairing.begin().code)
    })
  })

  describe('one time', () => {
    it('a used code fails for a second account', () => {
      const { code } = pairing.begin()
      expect(pairing.attempt('7', code, seconds())).toBe('ok')
      expect(pairing.attempt('8', code, seconds())).toBe('invalid')
    })

    it('a new code kills the old one', () => {
      const first = pairing.begin().code
      const second = pairing.begin().code
      expect(pairing.attempt('7', first, seconds())).toBe('invalid')
      expect(pairing.attempt('7', second, seconds())).toBe('ok')
    })

    it('cancel kills it', () => {
      const { code } = pairing.begin()
      pairing.cancel()
      expect(pairing.attempt('7', code, seconds())).toBe('invalid')
      expect(pairing.status()).toEqual({ active: false })
    })

    it('expiry: just before works, at the moment it does not', () => {
      const { code } = pairing.begin()
      clock.advance(5 * MINUTE - 1)
      expect(pairing.status().active).toBe(true)
      clock.advance(1)
      expect(pairing.status()).toEqual({ active: false })
      expect(pairing.attempt('7', code, seconds())).toBe('invalid')
    })

    it('a restart kills it: nothing is on disk', () => {
      const { code } = pairing.begin()
      state.save()
      pairing = fresh()
      expect(pairing.attempt('7', code, seconds())).toBe('invalid')
    })

    it('a code issued for another bot does not work once the bot changed', () => {
      const { code } = pairing.begin()
      state.adoptBot({ id: 2, username: 'c' })
      expect(pairing.attempt('7', code, seconds())).toBe('invalid')
    })

    it('begin is refused when someone is paired; a code from before does not add a second', () => {
      const { code } = pairing.begin()
      state.data.pairings.push({ accountId: '9', name: 'x', pairedAt: 1 })
      expect(pairing.attempt('7', code, seconds())).toBe('invalid')
      expect(() => pairing.begin()).toThrow('full')
    })
  })

  describe('message date', () => {
    it.each([
      ['the same second', 0, 'ok'],
      ['60 s before issue', 60, 'ok'],
      ['exactly 120 s before issue', 120, 'ok'],
      ['121 s before issue', 121, 'invalid'],
      ['a day before issue', 86_400, 'invalid'],
    ])('a correct code dated %s', (_name, before, result) => {
      const { code } = pairing.begin()
      expect(pairing.attempt('7', code, seconds() - (before as number))).toBe(result)
    })

    it('compares in whole seconds: issued at .999 of a second, dated 120 s before that second', () => {
      clock.advance(999 - (clock.now() % 1000))
      const issued = seconds()
      const { code } = pairing.begin()
      expect(pairing.attempt('7', code, issued - 120)).toBe('ok')
    })

    it('a backlog from before the code was issued neither locks anyone nor burns the code', () => {
      const { code } = pairing.begin()
      const old = seconds() - 1000
      for (let i = 0; i < 20; i++) expect(pairing.attempt(String(100 + i), WRONG, old)).toBe('invalid')
      expect(burned).toBe(0)
      expect(state.data.senders).toEqual({})
      expect(pairing.attempt('7', code, seconds())).toBe('ok')
    })
  })

  describe('per sender', () => {
    it('three wrong codes lock for an hour, the right code too', () => {
      const { code } = pairing.begin()
      expect([wrong('7'), wrong('7'), wrong('7')]).toEqual(['invalid', 'invalid', 'invalid'])
      expect(pairing.attempt('7', code, seconds())).toBe('locked')
      clock.advance(HOUR - 1)
      expect(pairing.attempt('7', pairing.begin().code, seconds())).toBe('locked')
    })

    it('the lock ends after an hour with a clean count', () => {
      pairing.begin()
      wrong('7'), wrong('7'), wrong('7')
      clock.advance(HOUR)
      const { code } = pairing.begin()
      expect(wrong('7')).toBe('invalid')
      expect(wrong('7')).toBe('invalid')
      expect(pairing.attempt('7', code, seconds())).toBe('ok')
    })

    it('the lock survives a restart', () => {
      pairing.begin()
      wrong('7'), wrong('7'), wrong('7')
      state.save()
      state = TelegramState.open(join(root, 'tg', 'state.json'), nullLogger)
      pairing = fresh()
      expect(pairing.attempt('7', pairing.begin().code, seconds())).toBe('locked')
    })

    it('old typos decay: a count older than the lock window starts over', () => {
      pairing.begin()
      wrong('7'), wrong('7')
      clock.advance(HOUR)
      pairing.begin()
      expect(wrong('7')).toBe('invalid')
      expect(state.data.senders['7'].wrong).toBe(1)
      expect(state.data.senders['7'].lockedUntil).toBeUndefined()
      expect(pairing.attempt('7', pairing.begin().code, seconds())).toBe('ok')
    })

    it('inside the window the count holds', () => {
      pairing.begin()
      wrong('7'), wrong('7')
      clock.advance(HOUR - 1)
      pairing.begin()
      wrong('7')
      expect(pairing.attempt('7', pairing.begin().code, seconds())).toBe('locked')
    })

    it('another sender is not locked', () => {
      const { code } = pairing.begin()
      wrong('7'), wrong('7'), wrong('7')
      expect(pairing.attempt('8', code, seconds())).toBe('ok')
    })

    it('with no code out, a guess costs nothing and writes nothing: state does not grow for strangers', () => {
      for (let i = 0; i < 50; i++) expect(pairing.attempt('7', WRONG, seconds())).toBe('invalid')
      expect(pairing.attempt("8", WRONG, seconds())).toBe("invalid")
      expect(state.data.senders).toEqual({})
    })

    it('success clears the sender record', () => {
      const { code } = pairing.begin()
      wrong('7')
      expect(pairing.attempt('7', code, seconds())).toBe('ok')
      expect(state.data.senders['7']).toBeUndefined()
    })

    it('keeps at most 1000 senders and drops the oldest, whatever the id order', () => {
      // 数字键在对象里按大小排,不是插入顺序:最老的 id 故意最大
      const ids = [...Array(1001).keys()].map(i => String(100_000 - i))
      for (const [n, id] of ids.entries()) {
        if (n % 9 === 0) pairing.begin()
        clock.advance(1)
        wrong(id)
      }
      const kept = Object.keys(state.data.senders)
      expect(kept).toHaveLength(1000)
      expect(kept).not.toContain(ids[0])
      expect(kept).toContain(ids[1000])
    })
  })

  describe('per code', () => {
    const tenWrong = () => {
      for (let i = 0; i < 10; i++) expect(wrong(String(100 + Math.floor(i / 3)))).toBe('invalid')
    }

    it('ten wrong across senders burn it, once; the right code fails after that', () => {
      const { code } = pairing.begin()
      tenWrong()
      expect(burned).toBe(1)
      expect(pairing.status()).toEqual({ active: false })
      expect(pairing.attempt('7', code, seconds())).toBe('invalid')
      wrong('8')
      expect(burned).toBe(1)
    })

    it('nine do not', () => {
      const { code } = pairing.begin()
      for (let i = 0; i < 9; i++) wrong(String(100 + Math.floor(i / 3)))
      expect(burned).toBe(0)
      expect(pairing.attempt('7', code, seconds())).toBe('ok')
    })

    it('a locked sender hammering does not burn it', () => {
      const { code } = pairing.begin()
      for (let i = 0; i < 30; i++) wrong('7')
      expect(burned).toBe(0)
      expect(pairing.attempt('8', code, seconds())).toBe('ok')
    })

    it('a new code starts a new count', () => {
      pairing.begin()
      for (let i = 0; i < 9; i++) wrong(String(100 + Math.floor(i / 3)))
      pairing.begin()
      wrong('200')
      expect(burned).toBe(0)
    })
  })

  describe('replyAllowed', () => {
    it('3 per sender per hour', () => {
      expect([1, 2, 3, 4].map(() => pairing.replyAllowed('7'))).toEqual([true, true, true, false])
      expect(pairing.replyAllowed('8')).toBe(true)
      clock.advance(HOUR)
      expect(pairing.replyAllowed('7')).toBe(true)
    })

    it('30 overall per hour', () => {
      for (let i = 0; i < 30; i++) expect(pairing.replyAllowed(String(i))).toBe(true)
      expect(pairing.replyAllowed('1000')).toBe(false)
      clock.advance(HOUR)
      expect(pairing.replyAllowed('1000')).toBe(true)
    })

    it('a refused sender does not use up the global budget', () => {
      for (let i = 0; i < 100; i++) pairing.replyAllowed('7')
      for (let i = 0; i < 27; i++) expect(pairing.replyAllowed(String(i + 10))).toBe(true)
      expect(pairing.replyAllowed('99')).toBe(false)
    })
  })
})

describe('parsePairCommand', () => {
  it.each([
    ['/pair K7M2-9QXA', { command: 'pair', code: 'K7M2-9QXA' }],
    ['/pair   K7M2 9QXA  ', { command: 'pair', code: 'K7M2 9QXA' }],
    ['/pair@fake_bot K7M2-9QXA', { command: 'pair', code: 'K7M2-9QXA' }],
    ['/start K7M29QXA', { command: 'start', code: 'K7M29QXA' }],
    ['/pair', { command: 'pair' }],
    ['/start', { command: 'start' }],
    ['/start@fake_bot', { command: 'start' }],
    ['  /start  ', { command: 'start' }],
  ])('%s', (text, parsed) => {
    expect(parsePairCommand(text)).toEqual(parsed)
  })

  it.each(['hello', '/pairing x', '/started', 'pair K7M2', '/status', '/PAIR x', ' x /pair K7M2', ''])('%j is not one', text => {
    expect(parsePairCommand(text)).toBeUndefined()
  })
})
