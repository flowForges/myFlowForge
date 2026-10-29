// 在 Electron-as-Node 下验证 node:sqlite + WAL 可用。
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mffai-rt-'))
try {
  const db = new DatabaseSync(join(dir, 't.db'))
  const wal = db.prepare('PRAGMA journal_mode=WAL').get().journal_mode
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
  const ins = db.prepare('INSERT INTO t (v) VALUES (?)')
  db.exec('BEGIN')
  for (let i = 0; i < 1000; i++) ins.run('row' + i)
  db.exec('COMMIT')
  const n = db.prepare('SELECT COUNT(*) AS n FROM t').get().n
  db.close()
  const rssMb = Math.round(process.memoryUsage().rss / 1048576)
  console.log(JSON.stringify({ sqlite: n === 1000 ? 'ok' : 'bad', wal, rssMb }))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
