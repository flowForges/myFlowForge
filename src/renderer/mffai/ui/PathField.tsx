/** 路径输入 + 系统选择框(app 现有的 pickDirectory / pickFile) */
export function PathField({ value, onChange, kind, label, invalid }: {
  value: string
  onChange: (path: string) => void
  kind: 'directory' | 'file'
  label?: string
  invalid?: boolean
}) {
  const pick = () => {
    const f = window.forge
    void (kind === 'directory' ? f.pickDirectory() : f.pickFile())
      .then((p) => { if (p) onChange(p) })
      .catch((e) => console.error('mffai pick', e))
  }
  return (
    <span className="mffai-pathfield">
      <input aria-label={label ?? (kind === 'directory' ? '目录' : '文件')} aria-invalid={invalid || undefined} value={value} onChange={(e) => onChange(e.target.value)} />
      <button className="set-btn" onClick={pick}>选择</button>
    </span>
  )
}
