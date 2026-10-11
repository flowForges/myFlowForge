import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * 每个会话输入框里**还没发出去**的那段字。
 *
 * ★★2026-10-11 用户:「输入内容,没有提交,返回到首页列表,再点击这个会话,输入框内容就丢失了」。
 *  输入框的 state 长在聊天屏里,退回列表这一屏就卸了,字跟着没了。电脑端早就按会话存草稿
 *  (renderer 的 draftStore),手机这边补上同一件事。
 * ★存盘(而不只是放内存):app 被系统杀掉再打开,打了一半的长指令也还在。
 * ★按「工作区 + 会话」分开存:换一个会话看到的是那个会话自己的草稿,不会串。
 */
const KEY = 'mff.drafts.v1'
/** 最多留几个会话的草稿。★不封顶的话会随用随涨,而草稿是最不值钱的那种数据。 */
export const MAX_DRAFTS = 50
/** 单条草稿的上限(字符)。超长的照样留着,只是截掉尾巴 —— 一坨几十万字的粘贴不该拖慢每次存盘。 */
export const MAX_DRAFT_LEN = 20_000

export const draftKey = (wsPath: string, sessionId: string): string => `${wsPath}\u0000${sessionId}`

/** 磁盘上那份 → Map。★坏数据一律当空,不抛:草稿丢了顶多重打,读崩了是聊天屏打不开。 */
export function draftsFrom(raw: string | null): Map<string, string> {
  try {
    const v: unknown = raw ? JSON.parse(raw) : null
    if (!Array.isArray(v)) return new Map()
    const out = new Map<string, string>()
    for (const e of v) if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string' && e[1]) out.set(e[0], e[1])
    return out
  } catch {
    return new Map()
  }
}

/**
 * 写一条(不改原 Map,返回新的)。空白 = 删掉。
 * ★最近写的排在最后(Map 保插入序),超了 `MAX_DRAFTS` 从最早的开始丢。
 */
export function putDraft(m: ReadonlyMap<string, string>, key: string, text: string): Map<string, string> {
  const next = new Map(m)
  next.delete(key)
  if (text.trim()) next.set(key, text.slice(0, MAX_DRAFT_LEN))
  while (next.size > MAX_DRAFTS) next.delete(next.keys().next().value as string)
  return next
}

let mem = new Map<string, string>()
let loading: Promise<void> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

/** 第一次调用时从磁盘读,之后都是同一个已完成的 promise。 */
export function loadDrafts(): Promise<void> {
  loading ??= AsyncStorage.getItem(KEY)
    .then((raw) => { mem = draftsFrom(raw) })
    .catch(() => {})
  return loading
}

export const getDraft = (key: string): string => mem.get(key) ?? ''

/** 写内存立刻生效,落盘攒 600ms 一次 —— 每敲一个字写一次盘没有意义。 */
export function setDraft(key: string, text: string): void {
  if ((mem.get(key) ?? '') === text) return
  mem = putDraft(mem, key, text)
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void AsyncStorage.setItem(KEY, JSON.stringify([...mem])).catch(() => {})
  }, 600)
}
