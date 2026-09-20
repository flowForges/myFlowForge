import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * preload 里那四条终端入口**必须走 `invoke`**。
 *
 * ★★这条扫源码的断言看着笨,但它挡的是一个**没有任何别的东西挡得住**的回归:
 *  `ipcRenderer.send` 是单向的,而单向消息**不经过主机路由器**(路由器只包在
 *  `ipcMain.handle` 外面)。改回 send 之后:
 *   - 编译过、类型对、所有单元测试全绿;
 *   - 本机用起来一切正常;
 *   - 只有**连着远程主机**的时候才出问题 —— 而且是最坏的那种:终端照样响应、
 *     字打得进去,但敲的是**你面前这台**机器。`rm -rf` 敲错机器不是「功能缺失」。
 *
 *  preload 不在任何 vitest project 的 include 里(它是打包进渲染进程的独立入口),
 *  所以这里直接读源码。比起为它单独搭一套测试环境,一条正则更诚实。
 */

const SRC = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')

describe('preload 的终端入口', () => {
  it('四条全部是 invoke,一条 send 都不许有', () => {
    const sends = [...SRC.matchAll(/ipcRenderer\.send\(\s*CH\.(term\w*)/g)].map(m => m[1])
    expect(sends, '这几条改回单向了 —— 连着远程主机时会写进本机的 shell').toEqual([])
  })

  it('write / resize / kill 三条确实在(不是被整段删掉才"没有 send")', () => {
    // 上面那条断言在「这三个函数根本不存在」时也会绿。钉住它们真的还在。
    for (const m of ['termWrite', 'termResize', 'termKill', 'termCreate']) {
      expect(SRC).toContain(`${m}:`)
      expect(new RegExp(`${m}:[^\\n]*ipcRenderer\\.invoke`).test(SRC), `${m} 应该走 invoke`).toBe(true)
    }
  })

  it('invoke 的 promise 都接住了 —— 每敲一个键漏一条 unhandledRejection 是灾难', () => {
    for (const line of SRC.split('\n').filter(l => /^\s*term(Write|Resize|Kill):/.test(l))) {
      expect(line, line.trim()).toContain('.catch(')
    }
  })
})
