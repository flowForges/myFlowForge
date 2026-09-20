import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 真的落到临时目录上跑 —— 这个模块的价值有一半在「权限对不对、第二次写还对不对」,
// 那是 mock 掉 fs 就看不见的东西。
let dir = ''
vi.mock('../config/paths', () => ({ sysFile: (n: string) => join(dirRef.current, n) }))
const dirRef = { current: '' }

import { readDevices, registerDevice, removeDevice, removeDevices, touchDevice, MAX_DEVICES } from './pushStore'

const NOW = 1_700_000_000_000
const file = () => join(dir, 'push-devices.json')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'push-store-'))
  dirRef.current = dir
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('pushStore', () => {
  it('没有文件时是空表,不抛', () => {
    expect(readDevices()).toEqual([])
  })

  it('登记一台,读得回来', () => {
    registerDevice({ token: 'ExponentPushToken[a]', label: 'iPhone', platform: 'ios' }, NOW)
    expect(readDevices()).toEqual([
      { token: 'ExponentPushToken[a]', label: 'iPhone', platform: 'ios', registeredAt: NOW, lastSeenAt: NOW },
    ])
  })

  it('重复登记同一枚令牌只更新,不新增一条', () => {
    registerDevice({ token: 't1', label: '旧名字' }, NOW)
    registerDevice({ token: 't1', label: '新名字' }, NOW + 5000)
    const ds = readDevices()
    expect(ds).toHaveLength(1)
    expect(ds[0]!.label).toBe('新名字')
    // ★首次登记时间保留 —— 设置里那句「什么时候配的」不该每次连上都被刷成现在
    expect(ds[0]!.registeredAt).toBe(NOW)
    expect(ds[0]!.lastSeenAt).toBe(NOW + 5000)
  })

  it('令牌两头的空白会被剃掉,空令牌直接拒', () => {
    registerDevice({ token: '  t1  ' }, NOW)
    expect(readDevices()[0]!.token).toBe('t1')
    expect(() => registerDevice({ token: '   ' }, NOW)).toThrow()
  })

  it('名字过长截断(标题栏和设置里都排不下)', () => {
    registerDevice({ token: 't1', label: 'x'.repeat(200) }, NOW)
    expect(readDevices()[0]!.label).toHaveLength(64)
  })

  it('★文件权限是 0600,而且第二次写之后还是', () => {
    registerDevice({ token: 't1' }, NOW)
    expect(statSync(file()).mode & 0o777).toBe(0o600)
    // 原子写是「写临时文件再 rename」,新文件带的是 umask 权限 —— 只在创建时 chmod 一次的话
    // 这一步会悄悄退回 0644。
    registerDevice({ token: 't2' }, NOW)
    expect(statSync(file()).mode & 0o777).toBe(0o600)
  })

  it('删掉一台', () => {
    registerDevice({ token: 't1' }, NOW)
    registerDevice({ token: 't2' }, NOW)
    expect(removeDevice('t1').map((d) => d.token)).toEqual(['t2'])
    expect(readDevices().map((d) => d.token)).toEqual(['t2'])
  })

  it('删一个不存在的不报错也不改动别人', () => {
    registerDevice({ token: 't1' }, NOW)
    expect(removeDevice('nope').map((d) => d.token)).toEqual(['t1'])
  })

  it('一次摘掉多枚死令牌', () => {
    registerDevice({ token: 't1' }, NOW)
    registerDevice({ token: 't2' }, NOW)
    registerDevice({ token: 't3' }, NOW)
    expect(removeDevices(['t1', 't3']).map((d) => d.token)).toEqual(['t2'])
  })

  it('摘空清单时不写盘也不炸', () => {
    registerDevice({ token: 't1' }, NOW)
    expect(removeDevices([]).map((d) => d.token)).toEqual(['t1'])
  })

  it('touch 只更新时间', () => {
    registerDevice({ token: 't1', label: 'n' }, NOW)
    touchDevice('t1', NOW + 9999)
    expect(readDevices()[0]!.lastSeenAt).toBe(NOW + 9999)
    expect(readDevices()[0]!.label).toBe('n')
  })

  it('★touch 一个没登记过的设备不会把它偷偷加进来', () => {
    touchDevice('never-registered', NOW)
    expect(readDevices()).toEqual([])
  })

  it(`★超过 ${MAX_DEVICES} 台时挤掉最久没露面的那台,不是最早注册的那台`, () => {
    // 一台老设备,天天在用
    registerDevice({ token: 'daily', label: '天天用' }, NOW)
    touchDevice('daily', NOW + 1_000_000)
    // 一堆注册过一次就再没出现的
    for (let i = 0; i < MAX_DEVICES; i++) registerDevice({ token: `ghost-${i}` }, NOW + i)
    const tokens = readDevices().map((d) => d.token)
    expect(tokens).toHaveLength(MAX_DEVICES)
    expect(tokens).toContain('daily')
    expect(tokens).not.toContain('ghost-0')
  })

  it('磁盘上那份坏了时退回空表,不是抛出来把网关带崩', () => {
    writeFileSync(file(), '{ 这不是 json')
    expect(readDevices()).toEqual([])
  })

  it('单条记录字段缺失/类型不对时被 catch 兜住,不整份丢掉', () => {
    writeFileSync(file(), JSON.stringify({ version: 1, devices: [{ token: 't1', platform: '火星' }] }))
    expect(readDevices()).toEqual([{ token: 't1', label: '', platform: 'ios', registeredAt: 0, lastSeenAt: 0 }])
  })
})
