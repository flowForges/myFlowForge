import { describe, it, expect } from 'vitest'
import { parseProjects, parsePlugins, parsePet, PROJ_SAMPLE, PLUGIN_SAMPLE, PET_SAMPLE } from './importParsers'

describe('parseProjects', () => {
  it('parses a JSON array (repo/url/git + branch/ref aliases)', () => {
    expect(parseProjects('[{"repo":"git@x:y/a.git","branch":"main"},{"url":"https://x/b.git","ref":"dev"}]'))
      .toEqual([{ repo: 'git@x:y/a.git', branch: 'main' }, { repo: 'https://x/b.git', branch: 'dev' }])
  })
  it('parses per-line "repo, branch" (and bare repo → main), skipping #comments', () => {
    expect(parseProjects('# header\ngit@x:y/a.git, dev\n/local/path\n')).toEqual([
      { repo: 'git@x:y/a.git', branch: 'dev' },
      { repo: '/local/path', branch: 'main' },
    ])
  })
  it('the sample parses to 4 projects', () => {
    expect(parseProjects(PROJ_SAMPLE)).toHaveLength(4)
  })
})

describe('parsePlugins', () => {
  it('keeps valid after/skills/tools and drops unknown ones; bad after → __start', () => {
    expect(parsePlugins('[{"name":"X","prompt":"p","after":"nope","skills":["analyze","bogus"],"tools":["bash","nope"]}]'))
      .toEqual([{ name: 'X', prompt: 'p', after: '__start', skills: ['analyze'], tools: ['bash'] }])
  })
  it('maps the legacy "assess" stage to "requirement"', () => {
    expect(parsePlugins('[{"name":"X","after":"assess"}]')[0].after).toBe('requirement')
  })
  it('throws when no entry has a name', () => {
    expect(() => parsePlugins('[{"prompt":"p"}]')).toThrow()
  })
  it('the sample parses to 2 plugins', () => {
    expect(parsePlugins(PLUGIN_SAMPLE)).toHaveLength(2)
  })
})

describe('parsePet', () => {
  it('requires name + emoji', () => {
    expect(() => parsePet('{"name":"x"}')).toThrow(/emoji/)
    expect(() => parsePet('{"emoji":"🐱"}')).toThrow(/name/)
  })
  it('parses the sample to one pet', () => {
    expect(parsePet(PET_SAMPLE)).toEqual([{ name: '豆豆', emoji: '🐱', color: 'oklch(72% .16 30)' }])
  })
})
