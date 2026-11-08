/** 稳定代码原样显示(05、07、09:代码就是给界面直接显示的) */
export function CodeChip({ code, title }: { code: string; title?: string }) {
  return <code className="mffai-badge mffai-code" title={title}>{code}</code>
}
