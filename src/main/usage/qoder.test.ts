import { describe, it, expect } from 'vitest'
import { fetchQoderUsage } from './qoder'

describe('fetchQoderUsage', () => {
  it('rejects asking the user to paste a token when none is provided', async () => {
    await expect(fetchQoderUsage()).rejects.toThrow(/无法自动读取凭据/)
  })
  it('rejects with an API-pending message when a credential is provided', async () => {
    await expect(fetchQoderUsage('some-token')).rejects.toThrow(/待接入/)
  })
})
