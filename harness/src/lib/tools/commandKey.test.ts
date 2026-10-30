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
    ['cat ./a.txt', 'cat'],
    ['./gradlew build', './gradlew build'],
    ['make', 'make'],
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
    // 控制者裁定:$ 展开、VAR= 前缀、第二个词以 - 开头
    'echo $HOME',
    'echo ${X}',
    'FOO=1 npm publish',
    'ls -la',
    'git -c core.x=y status',
    'npm --prefix x publish',
    'git "status"',
    "git 'push' --force",
    // 解释器 / 提权 / 破坏性
    'rm -rf build',
    'rm',
    'sudo npm test',
    'bash -c x',
    'node 1x.js',
    'python3 x.py',
    'python3.12 -c x',
    'python script.py',
    'find . -delete',
    'xargs rm',
    'env npm test',
    // 换个拼写绕名单
    '/bin/rm build',
    'RM build',
    'Bash -c x',
    'bash.exe -c x',
    'C:\\Windows\\System32\\cmd.exe /c dir',
    'pwsh.ps1 x',
    '"rm" build',
    '\\rm build',
    "r''m build",
    '(rm build',
    '/bin/r? build',
    '~/bin/x run',
    // 执行另一条命令的包装器
    'timeout 60 npm test',
    'nohup rm -rf build',
    'time npm test',
    'nice npm test',
    'ssh host ls',
    '. ./x.sh',
    'source x.sh',
    'watch npm test',
    'caffeinate npm test',
    'command rm x',
    'builtin cd x',
    'stdbuf npm test',
    'script out.txt',
  ])('%j → undefined', command => {
    expect(sessionKey(command)).toBeUndefined()
  })
})
