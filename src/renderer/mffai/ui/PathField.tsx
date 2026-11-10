import { Icon } from '../shell/icons'

/** 路径输入 + 系统选择框(app 现有的 pickDirectory / pickFile) */
export function PathField({ value, onChange, kind, label, invalid, iconOnly }: {
  value: string
  onChange: (path: string) => void
  kind: 'directory' | 'file'
  label?: string
  invalid?: boolean
  /** 选择按钮只画文件夹图标(文字留给读屏) */
  iconOnly?: boolean
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
      {iconOnly
        ? <button className="set-btn mffai-iconbtn" onClick={pick}><Icon name="folder" size={14} /><span className="mffai-sr">选择</span></button>
        : <button className="set-btn" onClick={pick}>选择</button>}
    </span>
  )
}
