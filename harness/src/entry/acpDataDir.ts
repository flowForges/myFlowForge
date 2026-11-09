import { homedir } from 'node:os'
import { join } from 'node:path'
import { dataDir } from '../protocol/index'

// 跟 src/main/config/sysDirName.ts 的 isValidSysDirName 同一条规则(harness 不 import src/**);构建期已经拒掉了不合格的名字,这里只是保险
const validName = (v: string) => /^\.[A-Za-z0-9._-]+$/.test(v) && !/^\.+$/.test(v) && v.toLowerCase() !== '.myflowforge'

/** mffaiAcp.js 的数据目录:MFFAI_DATA_DIR 优先;否则 <home>/<构建期目录名>/mff-ai;没有构建期目录名 → dataDir() */
export function acpDataDir(env: Record<string, string | undefined>, builtName: string | undefined, home: string = homedir()): string {
  if (env.MFFAI_DATA_DIR) return env.MFFAI_DATA_DIR
  return builtName && validName(builtName) ? join(home, builtName, 'mff-ai') : dataDir(home)
}
