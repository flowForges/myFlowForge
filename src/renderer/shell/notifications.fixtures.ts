// Test-only fixture. NOT imported by any runtime code — kept out of the production
// notifications module so no mock notification data ships in the app.
import type { Notif } from './notifications'

export const MOCK_NOTIFS: Notif[] = [
  { ic: 'ok',   cls: 'ni-ok',   t: '<b>design-system-v3</b> 的代码 Review 阶段已完成', m: 'Reviewer · 2 分钟前', unread: true },
  { ic: 'file', cls: 'ni-file', t: '<b>api-gateway</b> 有 11 个文件变更待查看', m: '文件追踪 · 14 分钟前', unread: true },
  { ic: 'warn', cls: 'ni-warn', t: '<b>部署代理</b> 在等待你确认目标分支', m: '需要操作 · 23 分钟前', unread: false },
  { ic: 'ok',   cls: 'ni-ok',   t: '工作区 <b>mobile-redesign</b> 全部阶段执行完毕', m: '编排 · 1 小时前', unread: false },
]
