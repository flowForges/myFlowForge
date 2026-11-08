// auto 的警告就是开关的标签(08 §16),没有第二行。两条标签在源码扫描的白名单里。
export const AUTO_LABEL = '自动放行 · 命令不经你看 · 能读凭据清单以外的文件'
export const UNSANDBOXED_AUTO_LABEL = '无沙箱时自动放行 · 命令不隔离 · 能读写凭据清单以外的文件'

export function AutoSwitch({ checked, disabled, onChange, label = AUTO_LABEL }: {
  checked: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
  label?: typeof AUTO_LABEL | typeof UNSANDBOXED_AUTO_LABEL
}) {
  return (
    <label className={`mffai-switch${disabled ? ' off' : ''}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}
