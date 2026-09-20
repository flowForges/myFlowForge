import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, Platform } from 'react-native'
import { router } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useConn } from '../net/conn'
import { useStore } from '../data/store'
import { ROUTES } from '../nav/routes'
import type { Presence } from '../../../src/shared/push/attention'
import {
  DEFAULT_LOCAL_PUSH, localNotificationFor, parseLocalPushPrefs,
  PRESENCE_HEARTBEAT_MS, shouldReportPresence, type LocalPushPrefs,
} from './decide'
import {
  ensureChannel, getPushToken, installHandler, onNotificationTap, permissionState,
  presentLocal, requestPermission, EAS_PROJECT_ID, type PermState,
} from './notify'

/**
 * 手机端提醒的总接线。
 *
 * ★★两条腿,别把它们混成一件事:
 *  ①**本地通知** —— app 开着但你在看别的会话时,手机自己弹一条。**零凭据就能用。**
 *  ②**远程推送** —— app 被切走/被系统挂起后,由那台机器直接 POST 给 Expo。
 *    它需要 `app.json` 里的 `extra.eas.projectId` 和 Expo 上传好的 APNs/FCM 凭据,
 *    **那要用户自己的 Expo 账号**。没配的时候设置里要**说清楚差哪一步**,
 *    绝不能是一个点了没反应的开关。
 *
 * 两条腿的分界线是同一个 `attentionOf`(和 daemon 共用),所以同一件事不会弹两条。
 */

const PUSH_KEY = 'mff.push.v1'

export type PushApi = {
  prefs: LocalPushPrefs
  setPrefs: (p: LocalPushPrefs) => void
  permission: PermState
  /** 点开关时才去要权限 —— 冷启动就弹系统框最容易被直接拒。 */
  askPermission: () => Promise<PermState>
  /** 远程推送令牌。null = 没拿到,原因在 `tokenReason`。 */
  token: string | null
  tokenReason: string
  /** 这台机器认不认 push:* 那几个方法(老 daemon 不认,设置里要置灰)。 */
  hostSupports: boolean
  /**
   * 设置里那颗「弹一条试试」。走的是本地通知,不需要任何服务器配置。
   * ★返回一句错误原因(没权限时);成功就是 null —— **绝不静默失败**。
   */
  testLocal: () => Promise<string | null>
}

const Ctx = createContext<PushApi | null>(null)

export function PushProvider({ children }: { children: React.ReactNode }) {
  const conn = useConn()
  const store = useStore()

  const [prefs, setPrefsState] = useState<LocalPushPrefs>(DEFAULT_LOCAL_PUSH)
  const [permission, setPermission] = useState<PermState>('undetermined')
  const [token, setToken] = useState<string | null>(null)
  const [tokenReason, setTokenReason] = useState('')
  const [visible, setVisible] = useState(AppState.currentState === 'active')

  // ★ref 而不是 state:它们只被回调读,进 state 会让每次上报都重渲染整棵树。
  const lastPresence = useRef<Presence | null>(null)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const viewingRef = useRef(store.viewing)
  viewingRef.current = store.viewing

  const hostSupports = conn.methods.has('push:register')

  // ── 一次性的初始化 ────────────────────────────────────────────────────────
  useEffect(() => {
    installHandler()
    void ensureChannel()
    void permissionState().then(setPermission)
    void AsyncStorage.getItem(PUSH_KEY)
      .then((raw) => { setPrefsState(parseLocalPushPrefs(raw ? JSON.parse(raw) : null)) })
      .catch(() => { /* 读不出来就用默认 */ })
  }, [])

  const setPrefs = useCallback((p: LocalPushPrefs) => {
    setPrefsState(p)
    void AsyncStorage.setItem(PUSH_KEY, JSON.stringify(p)).catch(() => { /* 存不上本次仍生效 */ })
  }, [])

  const askPermission = useCallback(async () => {
    await ensureChannel()
    const s = await requestPermission()
    setPermission(s)
    return s
  }, [])

  // ── 前后台 ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setVisible(s === 'active'))
    return () => sub.remove()
  }, [])

  // ── 远程推送令牌:权限给了才去要 ─────────────────────────────────────────
  useEffect(() => {
    if (permission !== 'granted' || !prefs.enabled) return
    let alive = true
    void getPushToken().then((r) => {
      if (!alive) return
      if (r.ok) { setToken(r.token); setTokenReason('') }
      else { setToken(null); setTokenReason(r.reason) }
    })
    return () => { alive = false }
  }, [permission, prefs.enabled])

  // ── 把令牌登记到当前这台主机上 ───────────────────────────────────────────
  //    ★依赖里带 epoch:切主机之后要重新登记 —— 设备表是**每台机器各存各的**。
  useEffect(() => {
    if (!token || !conn.online || !hostSupports) return
    const label = Platform.select({ ios: 'iPhone', android: 'Android 手机', default: '手机' }) as string
    const platform = Platform.OS === 'android' ? 'android' : Platform.OS === 'ios' ? 'ios' : 'web'
    void conn.invoke('push:register', [{ token, label, platform }]).catch(() => { /* 下次连上再说 */ })
  }, [token, conn.online, hostSupports, conn.epoch, conn.invoke])

  // ── 在场上报 ─────────────────────────────────────────────────────────────
  //    ★节流 + 心跳都在 `shouldReportPresence` 里。这里只负责「什么时候去问它一次」。
  const report = useCallback((now: number) => {
    if (!token || !conn.online || !hostSupports) return
    const v = viewingRef.current
    const next: Presence = {
      visible,
      at: v ? { workspacePath: v.wsPath, sessionId: v.sessionId } : null,
      reportedAt: now,
    }
    if (!shouldReportPresence(lastPresence.current, next)) return
    lastPresence.current = next
    void conn.invoke('push:presence', [{ token, visible: next.visible, at: next.at }]).catch(() => {})
  }, [token, conn.online, hostSupports, conn.invoke, visible])

  useEffect(() => { report(Date.now()) }, [report, store.viewing])

  useEffect(() => {
    if (!token || !conn.online) return
    const t = setInterval(() => report(Date.now()), PRESENCE_HEARTBEAT_MS)
    return () => clearInterval(t)
  }, [report, token, conn.online])

  // ★断线时把「上次报的是什么」忘掉:重连之后必须**立刻**重报一次 ——
  //  那台机器在断开期间已经把这条连接上的在场状态丢了(它只活在内存里)。
  useEffect(() => { if (!conn.online) lastPresence.current = null }, [conn.online])

  // ── 事件 → 本地通知 ──────────────────────────────────────────────────────
  useEffect(() => {
    const handle = (channel: string) => (payload: unknown) => {
      const v = viewingRef.current
      const m = localNotificationFor(channel, payload, {
        presence: { visible, at: v ? { workspacePath: v.wsPath, sessionId: v.sessionId } : null, reportedAt: Date.now() },
        prefs: prefsRef.current,
        workspaceName: store.wsName,
        now: Date.now(),
      })
      if (m) void presentLocal(m)
    }
    const off1 = conn.on('chat:event', handle('chat:event'))
    const off2 = conn.on('run2:event', handle('run2:event'))
    return () => { off1(); off2() }
  }, [conn.on, conn, visible, store.wsName])

  // ── 点通知 → 跳过去 ─────────────────────────────────────────────────────
  useEffect(() => {
    return onNotificationTap((t) => {
      store.ensureWs(t.wsPath)
      if (t.sessionId) {
        store.select({ wsPath: t.wsPath, sessionId: t.sessionId })
        router.push(ROUTES.chat)
        return
      }
      // 工作区级(工作流的门)。★`/exec` 吃的是 `selected`,所以得先给它选一条会话 ——
      //  选不出来就老老实实回列表,别推一屏空的进去。
      const g = store.groups.find((x) => x.ws.path === t.wsPath)
      const first = g?.sessions[0]
      if (first) {
        store.select({ wsPath: t.wsPath, sessionId: first.id })
        router.push(ROUTES.exec)
      } else {
        router.navigate(ROUTES.home)
      }
    })
  }, [store])

  /**
   * ★★没有通知权限时,`presentLocal` 是**静默失败**的 —— 系统不弹,也不报错。
   *  那就是一颗「点了没反应」的按钮,而它恰恰是用来判断「提醒到底通没通」的那颗。
   *  所以这里先自己要一次权限,拿不到就**回一句人话**,由调用方显示出来。
   */
  const testLocal = useCallback(async (): Promise<string | null> => {
    let st = permission
    if (st !== 'granted') {
      st = await askPermission()
      if (st !== 'granted') {
        return st === 'denied'
          ? '系统里关掉了 myFlowForge 的通知,所以这条发不出去。去「设置 → 通知 → myFlowForge」打开。'
          : '没拿到通知权限,这条发不出去。'
      }
    }
    await presentLocal({
      title: 'myFlowForge · 试一下',
      body: '看到这条就说明手机上的提醒是通的。',
      data: { wsPath: '', sessionId: null, kind: 'done' },
    })
    return null
  }, [permission, askPermission])

  const value = useMemo<PushApi>(() => ({
    prefs, setPrefs, permission, askPermission, token, tokenReason, hostSupports, testLocal,
  }), [prefs, setPrefs, permission, askPermission, token, tokenReason, hostSupports, testLocal])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePush(): PushApi {
  const v = useContext(Ctx)
  if (!v) throw new Error('usePush 必须在 PushProvider 里用')
  return v
}

export { EAS_PROJECT_ID }
