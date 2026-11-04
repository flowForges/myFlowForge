import { describe, expect, it } from 'vitest'
import { fakeModels, type FakeAccount } from '../../../test/memoryRig'
import { MemoryConfigSchema, type MemoryConfig } from '../../lib/memory/types'
import { pickBackground } from './background'

const cfg = (over: Partial<MemoryConfig> = {}): MemoryConfig => ({ ...MemoryConfigSchema.parse({}), ...over })
const models = (...accounts: FakeAccount[]) => fakeModels({ accounts }).service
const priced = (id: string, input: number, extra: object = {}) => ({ id, cost: { input, output: input * 4 }, ...extra })
const ref = (accountId: string, modelId: string) => ({ accountId, modelId })

describe('pickBackground', () => {
  const session = ref('a', 'big')
  const rows: [string, FakeAccount[], Partial<MemoryConfig>, ReturnType<typeof ref> | undefined, ReturnType<typeof pickBackground>][] = [
    ['the cheapest by cost', [{ id: 'a', models: [priced('big', 15), priced('cheap', 0.25), priced('mid', 3)] }], {}, session, { ref: ref('a', 'cheap') }],
    ['a free model is still priced', [{ id: 'a', models: [priced('big', 15), priced('free', 0)] }], {}, session, { ref: ref('a', 'free') }],
    ['priced beats unpriced', [{ id: 'a', models: [{ id: 'gpt-mini' }, priced('big', 15)] }], {}, session, { ref: ref('a', 'big') }],
    ['deprecated skipped', [{ id: 'a', models: [priced('big', 15), priced('old', 0.1, { deprecated: true })] }], {}, session, { ref: ref('a', 'big') }],
    ['context under 16k skipped', [{ id: 'a', models: [priced('big', 15), priced('tiny', 0.1, { context: 15_999 })] }], {}, session, { ref: ref('a', 'big') }],
    ['context of exactly 16k kept', [{ id: 'a', models: [priced('big', 15), priced('tiny', 0.1, { context: 16_000 })] }], {}, session, { ref: ref('a', 'tiny') }],
    ['no prices: the id regex', [{ id: 'a', models: [{ id: 'big' }, { id: 'vendor-flash-2' }] }], {}, session, { ref: ref('a', 'vendor-flash-2') }],
    ['no prices: deprecated regex match skipped', [{ id: 'a', models: [{ id: 'big' }, { id: 'x-haiku', deprecated: true }] }], {}, session, { ref: ref('a', 'big') }],
    ['no prices: gemini does not count as mini', [{ id: 'a', models: [{ id: 'gemini-pro' }, { id: 'big' }] }], {}, session, { ref: ref('a', 'big') }],
    ['neither: the session model', [{ id: 'a', models: [{ id: 'other' }, { id: 'big' }] }], {}, session, { ref: ref('a', 'big') }],
    ['session model unknown to the catalog is still that model', [{ id: 'a', models: [{ id: 'other' }] }], {}, session, { ref: ref('a', 'big') }],
    ['session model too small and nothing else', [{ id: 'a', models: [{ id: 'big', context: 8000 }] }], {}, session, { none: 'no_model' }],
    ['session model deprecated and nothing else', [{ id: 'a', models: [{ id: 'big', deprecated: true }] }], {}, session, { none: 'no_model' }],
    ['coding-tools-only session', [{ id: 'a', restriction: 'coding-tools-only', models: [priced('big', 15)] }], {}, session, { none: 'restricted' }],
    ['unknown + subscription', [{ id: 'a', restriction: 'unknown', billing: 'subscription', models: [priced('big', 15)] }], {}, session, { none: 'unknown_subscription' }],
    ['unknown + metered', [{ id: 'a', restriction: 'unknown', billing: 'metered', models: [priced('big', 15)] }], {}, session, { ref: ref('a', 'big') }],
    ['never another account', [{ id: 'a', restriction: 'coding-tools-only', models: [priced('big', 15)] }, { id: 'b', models: [priced('cheap', 0.1)] }], {}, session, { none: 'restricted' }],
    ['cheaper model on another account is ignored', [{ id: 'a', models: [priced('big', 15)] }, { id: 'b', models: [priced('cheap', 0.1)] }], {}, session, { ref: ref('a', 'big') }],
    ['session account gone', [{ id: 'b', models: [priced('cheap', 0.1)] }], {}, session, { none: 'no_model' }],
    ['no session: the default account', [{ id: 'a', models: [priced('big', 15), priced('cheap', 1)] }, { id: 'b', models: [priced('c', 0.1)] }], {}, undefined, { ref: ref('a', 'cheap') }],
    ['no account at all', [], {}, undefined, { none: 'no_model' }],
    ['explicit model is used as given', [{ id: 'a', models: [priced('big', 15)] }, { id: 'b', models: [priced('pick', 9), priced('cheap', 0.1)] }], { backgroundModel: ref('b', 'pick') }, session, { ref: ref('b', 'pick') }],
    ['explicit on coding-tools-only', [{ id: 'a', models: [priced('big', 15)] }, { id: 'b', restriction: 'coding-tools-only', models: [priced('pick', 9)] }], { backgroundModel: ref('b', 'pick') }, session, { none: 'restricted' }],
    ['explicit on a removed account', [{ id: 'a', models: [priced('big', 15)] }], { backgroundModel: ref('gone', 'pick') }, session, { none: 'no_model' }],
  ]
  it.each(rows)('%s', (_name, accounts, over, sessionRef, want) => {
    expect(pickBackground(models(...accounts), cfg(over), sessionRef)).toEqual(want)
  })
})
