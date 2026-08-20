import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import './lightbox.css'

// 图片灯箱:对话气泡和文件预览里的图都太小,点一下看大图。
//
// 用 portal 挂到 document.body,而不是就地渲染 —— 就地会被聊天气泡/预览面板的 overflow 和层叠上下文
// 裁掉。关闭方式给三个:Esc、点遮罩、右上角按钮。刻意**不做**缩放拖拽(用户选的就是纯灯箱)。
export function Lightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    // 捕获阶段:上层(会话切换、预览关闭)也监听 Esc,灯箱开着时该由灯箱先吃掉这一下。
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <button className="lightbox-close" title="关闭 (Esc)" onClick={onClose} aria-label="关闭">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
      {/* 点图片本身不关闭,免得想看细节时手一抖就没了 */}
      <img className="lightbox-img" src={src} alt={alt ?? ''} onClick={e => e.stopPropagation()} />
    </div>,
    document.body,
  )
}
