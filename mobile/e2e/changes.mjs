import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { launch, attach } from './cdp.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const S = path.join(here, '.out')
fs.mkdirSync(S + '/shots', { recursive: true })
const ok = (l, c, e = '') => console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' — ' + e : ''}`)

const mock = spawn('node', [path.join(here, 'mock-daemon.mjs'), '6803', 'both'], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 1200))

const chrome = await launch(S + '/chrome-changes')
const p = await attach()
await p.setViewport(390, 844)
await p.goto('http://localhost:8081/add-host')
await new Promise((r) => setTimeout(r, 5000))
await p.typeInto('input[placeholder*="192.168"]', '127.0.0.1:6803')
await p.clickText('保存并连接')
await new Promise((r) => setTimeout(r, 5000))

await p.goto('http://localhost:8081/exec')
await new Promise((r) => setTimeout(r, 4000))
let t = await p.text()
ok('变更按项目分组', t.includes('FORGE') && t.includes('SITE'))
ok('顶栏给出总计', /3 个文件 \+60 −6/.test(t), t.split('\n')[2])
ok('没有改动的项目不占地方', !/API\n/.test(t))
ok('明说是只读的', t.includes('不提交、不回滚'))
await p.shot(S + '/shots/x-01-changes.png')

await p.clickText('src/main/ipc/handlers.ts')
await new Promise((r) => setTimeout(r, 2500))
t = await p.text()
ok('点开是行级 diff', t.includes('for (const g of pending)') && t.includes('已按新权限档放行'))
ok('diff 顶栏是文件名 + 全路径', t.includes('handlers.ts') && t.includes('src/main/ipc/handlers.ts'))
await p.shot(S + '/shots/x-02-diff.png')

await p.close()
chrome.kill()
mock.kill()
