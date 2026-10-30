import { describe, expect, it } from 'vitest'
import { sessionKey } from './commandKey'

describe('sessionKey', () => {
  it.each([
    ['npm test', 'npm test'],
    ['npm test -- -t x', 'npm test'],
    ['  npm   test\t--watch ', 'npm test'],
    ['npm publish', 'npm publish'],
    ['git status', 'git status'],
    ['git push --force', 'git push'],
    ['npm run build:prod', 'npm run'],
    ['pnpm vitest.run', 'pnpm vitest.run'],
    ['ls', 'ls'],
    ['ls -la', 'ls'],
    ['rm -rf build', 'rm'],
    ['cat ./a.txt', 'cat'],
    ['node 1x.js', 'node'],
    ['git "status"', 'git'],
  ])('%j → %j', (command, key) => {
    expect(sessionKey(command)).toBe(key)
  })

  it.each([
    'npm test && rm -rf x',
    'npm test; rm -rf x',
    'npm test & sleep 1',
    'npm test | tee out',
    'echo `whoami`',
    'echo $(whoami)',
    'npm test > out.txt',
    'npm test < in.txt',
    'npm test\nrm -rf x',
    'npm test\r\nrm -rf x',
    '',
    '   ',
  ])('%j → undefined', command => {
    expect(sessionKey(command)).toBeUndefined()
  })
})
