import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateExternal, claudeProjectSlug } from './locate'

function roots() {
  const base = mkdtempSync(join(tmpdir(), 'sl-roots-'))
  const r = { codex: join(base, 'codex', 'sessions'), claude: join(base, 'claude', 'projects'), qoder: join(base, 'qoder', 'projects') }
  return { base, r }
}
const put = (f: string) => { mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, '{}\n') }

describe('locateExternal', () => {
  it('claude: <root>/<slug>/<id>.jsonl, via the cwd slug or by scanning projects', async () => {
    const { r } = roots()
    const f = join(r.claude, claudeProjectSlug('/Users/me/my.proj'), 'abc-123.jsonl')
    put(f); put(join(r.claude, '-other', 'zzz.jsonl'))
    expect(claudeProjectSlug('/Users/me/my.proj')).toBe('-Users-me-my-proj')
    expect(await locateExternal('claude', 'abc-123', { roots: r, cwd: '/Users/me/my.proj' })).toBe(f)
    expect(await locateExternal('claude', 'abc-123', { roots: r })).toBe(f)
    expect(await locateExternal('claude', 'abc-123', { roots: r, cwd: '/wrong/cwd' })).toBe(f)
    expect(await locateExternal('claude', 'missing', { roots: r })).toBeUndefined()
  })

  it('codex: finds the rollout file whose name ends with the thread id anywhere under sessions/**', async () => {
    const { r } = roots()
    const id = '019a1b2c-3d4e-7f00-8000-000000000001'
    const f = join(r.codex, '2026', '11', '26', `rollout-2026-11-26T10-00-00-${id}.jsonl`)
    put(f); put(join(r.codex, '2026', '11', '25', 'rollout-2026-11-25T10-00-00-019a0000-0000-7000-8000-000000000009.jsonl'))
    expect(await locateExternal('codex', id, { roots: r })).toBe(f)
    expect(await locateExternal('codex', '019a1b2c', { roots: r })).toBeUndefined()
  })

  it('qoder: <root>/<project>/<id>.jsonl', async () => {
    const { r } = roots()
    const f = join(r.qoder, '-Users-me-proj', 'q-1.jsonl')
    put(f)
    expect(await locateExternal('qoder', 'q-1', { roots: r })).toBe(f)
  })

  it('absent roots (e.g. qoder never installed) or unsafe ids → undefined, no throw', async () => {
    const { r } = roots()
    for (const p of ['claude', 'codex', 'qoder'] as const) expect(await locateExternal(p, 'x', { roots: r })).toBeUndefined()
    put(join(r.claude, '-p', 'ok.jsonl'))
    expect(await locateExternal('claude', '../-p/ok', { roots: r })).toBeUndefined()
    expect(await locateExternal('claude', '', { roots: r })).toBeUndefined()
  })
})
