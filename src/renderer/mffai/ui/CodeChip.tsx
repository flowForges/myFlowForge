/** 稳定代码原样显示(05、07、09:代码就是给界面直接显示的)。tone:红 / 琥珀底 */
export function CodeChip({ code, title, tone }: { code: string; title?: string; tone?: 'bad' | 'warn' }) {
  return <code className={`mffai-badge mffai-code${tone ? ` ${tone}` : ''}`} title={title}>{code}</code>
}
