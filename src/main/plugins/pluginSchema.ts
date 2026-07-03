import { z } from 'zod'

export const PluginManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  provider: z.string().optional(),
  entry: z.string().min(1),
  refreshSec: z.number().default(300),
  version: z.string().optional(),
  native: z.boolean().optional(),
})
export type PluginManifest = z.infer<typeof PluginManifestSchema>

export const InstalledPluginSchema = z.object({
  id: z.string(),
  dir: z.string(),
  type: z.string(),
  provider: z.string().optional(),
  name: z.string(),
  entry: z.string(),
  refreshSec: z.number(),
  enabled: z.boolean().default(true),
  native: z.boolean().optional(),
})
export type InstalledPlugin = z.infer<typeof InstalledPluginSchema>

export const PluginsFileSchema = z.object({
  plugins: z.array(InstalledPluginSchema).default(() => []),
})
