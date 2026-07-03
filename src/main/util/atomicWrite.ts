import { writeFileSync, renameSync } from 'node:fs'

export interface AtomicWriteFs {
  writeFileSync: (file: string, data: string, enc: 'utf8') => void
  renameSync: (from: string, to: string) => void
}

const realFs: AtomicWriteFs = { writeFileSync, renameSync }

// Write raw text to `file` atomically: serialise to a sibling `.tmp`, then rename it over the
// target. A same-directory rename is atomic, so a concurrent reader — or a crash mid-write —
// never observes a half-written file. `fs` is injectable for tests that simulate a crash.
export function writeTextAtomic(file: string, text: string, fs: AtomicWriteFs = realFs): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

export function writeJsonAtomic(file: string, data: unknown, fs: AtomicWriteFs = realFs): void {
  writeTextAtomic(file, JSON.stringify(data, null, 2), fs)
}
