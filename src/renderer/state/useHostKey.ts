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
