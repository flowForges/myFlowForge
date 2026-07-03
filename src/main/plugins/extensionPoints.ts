import { z } from 'zod'

export const StatusbarUsageSchema = z.object({
  window5h: z.object({ used: z.number(), limit: z.number(), resetAt: z.number().optional() }).optional(),
  weekly:   z.object({ used: z.number(), limit: z.number(), resetAt: z.number().optional() }).optional(),
  label: z.string().optional(),
}).refine(v => !!(v.window5h || v.weekly), { message: '至少需要 window5h 或 weekly' })

export interface ExtensionPoint {
  validate(json: unknown): { ok: true; data: unknown } | { ok: false; error: string }
}

export const EXTENSION_POINTS: Record<string, ExtensionPoint> = {
  'statusbar-usage': {
    validate: (j) => {
      const r = StatusbarUsageSchema.safeParse(j)
      return r.success
        ? { ok: true, data: r.data }
        : { ok: false, error: r.error.issues[0]?.message ?? '校验失败' }
    },
  },
}
