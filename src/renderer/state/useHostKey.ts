import { useEffect, useState } from 'react'

/**
 * 当前正在看哪台机器。本机是 `'local'`。
 *
 * 用来给「跟设备但按 host 分键」的设置做键(Q3 的 lastActiveWorkspace) ——
 * 手机和电脑的「上次看的工作区」必然不同,连不同的 host 也必然不同,存成一个值会互相覆盖。
 */
export function useHostKey(): string {
  return useHost().key
}

/** 同上,但连主机名一起给 —— 设置面板要在标题里说清「是哪台机器」。 */
export function useHost(): { key: string; label: string } {
  const [state, setState] = useState({ key: 'local', label: '本机' })
  useEffect(() => {
    // 先订阅再拉快照,晚到的快照丢掉(理由见 RemoteBar)。
    // ★`window.forge` 整个可能不存在:宠物窗、以及一堆只渲染局部组件的测试都没有它。
    //   这个 hook 现在被标题栏里的「打开位置」用着,一路挂到根组件 —— 在这儿抛异常
    //   会让那些界面整个白掉,而它本身只是个「现在连着哪台机器」的小信息。
    const forge = window.forge as typeof window.forge | undefined
    if (!forge?.onHostStatus) return
    let pushed = false
    const apply = (s: { hostId: string | null; label: string }) => setState({ key: s.hostId ?? 'local', label: s.label })
    const off = forge.onHostStatus((s) => { pushed = true; apply(s) })
    void forge.hostsStatus?.().then((s) => { if (!pushed) apply(s) }).catch(() => { /* 拿不到就按本机 */ })
    return off
  }, [])
  return state
}

/**
 * 每次连接**变成 ready** 就 +1。用来在重连之后强制重拉服务端状态。
 *
 * ★设计文档 7.2 第 3 条:重连后一律重拉 `chatGateState`,**以服务端为准,不信本地缓存**。
 * 断线期间那边可能已经有人答了门、也可能新升了门;拿旧卡片接着显示,用户会对着一张
 * 早就不存在的门点「允许」。paseo 的原话是 "pending permission requests are not restored
 * from cache",理由相同。
 */
export function useHostReadySeq(): number {
  const [seq, setSeq] = useState(0)
  useEffect(() => {
    const forge = window.forge as typeof window.forge | undefined
    if (!forge?.onHostStatus) return
    return forge.onHostStatus((s) => { if (s.state.status === 'ready') setSeq((n) => n + 1) })
  }, [])
  return seq
}

/** 「取一条工具输出」的通道名(= main/ipc/channels.ts 的 `CH.chatToolOutput`)。 */
const TOOL_OUTPUT_METHOD = 'chat:tool-output'

/**
 * 当前这台主机能不能按需取单条工具输出(方法表里有没有 `chat:tool-output`)。
 *
 * ★★实时事件里的大段工具输出要不要摘掉,就看这一个:2026-09-04 之前的远程主机没有这条通道,
 *  摘掉了点开永远取不回来 —— 而事件里明明带着全文。历史那条路在这种主机上是 fail-open 的
 *  (它不认上限字段,照旧全量下发),实时这条也必须一样。
 * ★还不知道(快照没回来、连接中、没有 `window.forge`)一律当**取不到** = 不摘:慢一点总比少一段强。
 */
export function useToolOutputFetchable(): boolean {
  const [ok, setOk] = useState(false)
  useEffect(() => {
    const forge = window.forge as typeof window.forge | undefined
    if (!forge?.onHostStatus) return
    let pushed = false
    const apply = (s: { methods?: string[] }) => setOk(!!s.methods?.includes(TOOL_OUTPUT_METHOD))
    const off = forge.onHostStatus((s) => { pushed = true; apply(s) })
    void forge.hostsStatus?.().then((s) => { if (!pushed) apply(s) }).catch(() => { /* 拿不到就当取不到 */ })
    return off
  }, [])
  return ok
}
