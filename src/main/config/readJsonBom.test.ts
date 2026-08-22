import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { readJson } from './store'

// Node 的 readFileSync(..., 'utf8') 【不】剥 UTF-8 BOM,而 JSON.parse('﻿{...}') 会抛 ——
// readJson 的 catch 把它吞掉、静默回落到默认值。macOS 上很少碰到,**Windows 上太容易触发**:
// PowerShell 5.1 的 `Set-Content -Encoding UTF8` 就写 BOM,老记事本和不少编辑器也是。
// 后果不是"这次读失败",而是**用户全部设置被悄悄重置** —— settings / projects / workflows /
// agents / plugins,以及 workspaces.json(那意味着整个工作区列表消失)。
let dir: string
const Schema = z.object({ keep: z.string() })
const fallback = () => ({ keep: 'DEFAULTS' })

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'readjson-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('readJson 与 UTF-8 BOM', () => {
  it('没有 BOM 时正常读', () => {
    const f = join(dir, 'a.json')
    writeFileSync(f, JSON.stringify({ keep: 'MINE' }), 'utf8')
    expect(readJson(f, Schema, fallback)).toEqual({ keep: 'MINE' })
  })

  it('★ 带 BOM 的文件也要读出用户的值,而不是静默重置成默认值', () => {
    const f = join(dir, 'b.json')
    writeFileSync(f, '﻿' + JSON.stringify({ keep: 'MINE' }), 'utf8')
    expect(readJson(f, Schema, fallback)).toEqual({ keep: 'MINE' })
  })

  it('真正损坏的文件仍然回落默认值(不能为了容 BOM 把错误也吞成功)', () => {
    const f = join(dir, 'c.json')
    writeFileSync(f, '﻿{ this is not json', 'utf8')
    expect(readJson(f, Schema, fallback)).toEqual({ keep: 'DEFAULTS' })
  })

  it('文件不存在时回落默认值', () => {
    expect(readJson(join(dir, 'nope.json'), Schema, fallback)).toEqual({ keep: 'DEFAULTS' })
  })
})
