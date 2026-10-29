import type { DatabaseSync } from 'node:sqlite'

export class Receipts {
  private getStmt
  private putStmt

  constructor(db: DatabaseSync) {
    this.getStmt = db.prepare('SELECT method, result FROM receipts WHERE command_id = ?')
    this.putStmt = db.prepare('INSERT OR IGNORE INTO receipts(command_id, method, result, ts) VALUES (?, ?, ?, ?)')
  }

  get(commandId: string): { method: string; result: unknown } | undefined {
    const r = this.getStmt.get(commandId) as { method: string; result: string } | undefined
    return r ? { method: r.method, result: JSON.parse(r.result) } : undefined
  }

  put(commandId: string, method: string, result: unknown): void {
    this.putStmt.run(commandId, method, JSON.stringify(result ?? null), Date.now())
  }
}
