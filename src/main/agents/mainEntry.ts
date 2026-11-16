import { basename, dirname, join } from 'node:path'

/** Where rollup puts main-process code shared by several entries. electron.vite.config.ts sets chunkFileNames from
 *  this, and scripts/mainEntriesCheck.cjs fails a build whose shared code lands anywhere else. */
export const MAIN_CHUNK_DIR = 'chunks'

/**
 * Path of a separate main-process entry (forgeMcp.js, agentShim.js) that electron-vite writes to out/main.
 * Code shared by the index and daemon entries is bundled into out/main/chunks/, where `__dirname` is the chunk
 * directory, so `join(__dirname, name)` would point at a file that doesn't exist (实测 1.3.0-cu.1: the forge MCP
 * server failed every turn with MODULE_NOT_FOUND). Pass `__dirname` as `dir`.
 */
export function mainEntryPath(dir: string, name: string): string {
  return join(basename(dir) === MAIN_CHUNK_DIR ? dirname(dir) : dir, name)
}
