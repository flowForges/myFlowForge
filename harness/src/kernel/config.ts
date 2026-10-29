import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { z } from 'zod'

export const KernelConfigSchema = z.object({
  version: z.literal(1).default(1),
  plugins: z.object({ disabled: z.array(z.string()).default([]) }).default({ disabled: [] }),
})
export type KernelConfig = z.infer<typeof KernelConfigSchema>

export function saveConfig(file: string, cfg: KernelConfig): void {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(cfg, null, 2))
  renameSync(tmp, file)
}

export function loadConfig(file: string): KernelConfig {
  if (existsSync(file)) {
    try {
      return KernelConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      renameSync(file, `${file}.bad-${Date.now()}`)
    }
  }
  const cfg = KernelConfigSchema.parse({})
  saveConfig(file, cfg)
  return cfg
}
