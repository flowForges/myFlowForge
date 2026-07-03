import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DiscoveredSession } from '@shared/types'
import type { SessionSource } from './claude'
import { decodeDirCwd } from '../types'

// qoder 本机日志只有运行事件,无对话正文 → 仅登记元数据。cwd 取 session.config.loaded.data.project_root,回退目录名解码。
export const qoderSource: SessionSource = {
  id: 'qoder',
  scan(roots) {
    const out: DiscoveredSession[] = []
    if (!roots.qoder || !existsSync(roots.qoder)) return out
    for (const dir of readdirSync(roots.qoder, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const cwdDir = join(roots.qoder, dir.name)
      let cwd = decodeDirCwd(dir.name)
      for (const sess of readdirSync(cwdDir, { withFileTypes: true })) {
        if (!sess.isDirectory()) continue
        const segDir = join(cwdDir, sess.name, 'segments')
        if (!existsSync(segDir)) continue
        try {
          const segs = readdirSync(segDir).filter(f => f.endsWith('.jsonl')).map(f => join(segDir, f))
          let mt = 0
          for (const f of segs) {
            mt = Math.max(mt, statSync(f).mtimeMs)
            try { for (const ln of readFileSync(f, 'utf8').split('\n').filter(Boolean)) { const o = JSON.parse(ln); if (o?.data?.project_root) { cwd = o.data.project_root; break } } } catch { /* skip */ }
          }
          out.push({ source: 'qoder', externalId: sess.name, cwd, title: '历史会话(无可读正文)', startedAt: mt, lastTs: mt, messageCount: 0, filePaths: segs, hasBody: false })
        } catch { /* skip */ }
      }
    }
    return out
  },
  readMessages() { return [] },
}
