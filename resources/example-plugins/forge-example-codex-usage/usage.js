#!/usr/bin/env node
// 内置示例插件：输出演示用的额度数据（statusbar-usage）。数据为示例样例，仅用于演示扩展点。
const nowSec = Math.floor(Date.now() / 1000)
const label = process.env.FORGE_PROVIDER ? process.env.FORGE_PROVIDER + ' · 示例' : '示例'
process.stdout.write(JSON.stringify({
  window5h: { used: 1240, limit: 4000, resetAt: nowSec + 3 * 3600 },
  weekly: { used: 18, limit: 40 },
  label,
}))
