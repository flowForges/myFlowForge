// src/renderer/views/QuickStart.tsx
// 首次使用引导:HomeView 空态(没有任何工作区)时显示的「快速开始」三步卡。
// 痛点:CLI 检测只跑 --version 判断"装没装",从不校验登录态——装了没登录的用户
// 选个文件夹开始对话会直接失败,且 InstallBanner(只在"一个都没装"时出现)不会提醒。
// 本卡补上"安装 → 登录 → 开始使用"的完整引导;可"不再显示"(localStorage 持久化)。
import { useEffect, useState } from 'react'
import type { ProviderInfo } from '@shared/types'
import { getBuiltinProvider } from '@shared/providerCatalog'
import { CopyBtn } from './InstallBanner'

export const QUICKSTART_DISMISS_KEY = 'forge.quickstartDismissed'

function readDismissed(): boolean {
  try { return localStorage.getItem(QUICKSTART_DISMISS_KEY) === '1' } catch { return false }
}
function writeDismissed(): void {
  try { localStorage.setItem(QUICKSTART_DISMISS_KEY, '1') } catch { /* ignore */ }
}

interface Props {
  onQuickFolder: () => void   // 第 3 步:选择文件夹开始对话(复用空态卡回调)
  onNew: () => void           // 第 3 步:创建工作区(复用空态卡回调)
}

export function QuickStart({ onQuickFolder, onNew }: Props) {
  const [dismissed, setDismissed] = useState(readDismissed)
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null)
  // 与 InstallBanner 同源:直接走 detectProviders,不新增 IPC。
  useEffect(() => { void window.forge.detectProviders().then((p: ProviderInfo[]) => setProviders(p)) }, [])
  if (dismissed || !providers) return null

  const builtins = providers.filter(p => !p.custom)
  const installed = builtins.filter(p => p.installed)
  // 一个都没装 → InstallBanner 已在上方列出安装命令,第 1 步不再重复,指向它即可。
  const bannerVisible = builtins.length === 0 || installed.length === 0

  return (
    <div className="quickstart">
      <div className="qs-head">
        <div>
          <div className="qs-title">快速开始</div>
          <div className="qs-sub">第一次使用?三步配置好编码代理,就能开始对话。</div>
        </div>
        <button className="qs-close" aria-label="不再显示" title="不再显示" onClick={() => { writeDismissed(); setDismissed(true) }}>×</button>
      </div>

      <div className="qs-steps">
        <div className="qs-step">
          <div className="qs-step-h"><span className="qs-num">1</span>安装编码代理 CLI</div>
          {bannerVisible ? (
            <div className="qs-hint">本机还没有检测到任何编码代理——按上方横幅里的命令安装任意一个即可。</div>
          ) : (
            <div className="qs-rows">
              {builtins.filter(p => p.installCmd).map(p => (
                <div className="qs-row" key={p.id}>
                  <span className="qs-row-name">{p.displayName}</span>
                  {p.installed
                    ? <span className="qs-ok">✓ 已安装</span>
                    : <><code>{p.installCmd}</code><CopyBtn text={p.installCmd!} /></>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="qs-step">
          <div className="qs-step-h"><span className="qs-num">2</span>登录 CLI</div>
          <div className="qs-hint">安装后需在终端登录一次,否则无法对话。运行下面的命令,按提示完成登录:</div>
          {installed.length > 0 ? (
            <div className="qs-rows">
              {installed.map(p => {
                const auth = p.authCmd ?? getBuiltinProvider(p.id)?.authCmd
                if (!auth) return null
                return (
                  <div className="qs-row" key={p.id}>
                    <span className="qs-row-name">{p.displayName}</span>
                    <code>{auth}</code>
                    <CopyBtn text={auth} />
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="qs-hint faint">完成第 1 步安装后,这里会显示对应的登录命令。</div>
          )}
        </div>

        <div className="qs-step">
          <div className="qs-step-h"><span className="qs-num">3</span>开始使用</div>
          <div className="qs-hint">登录完成后,选一个入口开始:</div>
          <div className="qs-actions">
            <button className="qs-btn primary" onClick={onQuickFolder}>选择文件夹开始对话</button>
            <button className="qs-btn" onClick={onNew}>创建工作区</button>
          </div>
        </div>
      </div>
    </div>
  )
}
