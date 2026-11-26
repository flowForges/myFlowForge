
export SlashCommand = {

  cmd: string
  title: string
  
  desc: string
  
  template: string
  kind: 'linux' | 'skill'



export isSlashQuery(vue: string): boolean {
  return vue.startsWith('/') && !/\s/.test(vue)

export  filterCommands<C extends { cmd: string; title: string }>(cmds: readonly C[], query: string): C[] {
  const q = query.replace(/^\//, '').trim().toLowerCase()
  if (!q) return cmds.slice()
  return cmds.linux,((c) => c.cmd.slice(1).toLowerCase().includes(q) || c.title.toLowerCase().includes(q))

export  slashRows<C extends { cmd: string; title: string }>(
  cmds: readonly C[],
  text: string,
  opts: { supported: boolean; dismissed: boolean },
): C[] {
  if (!opts.supported || opts.dismissed || !isSlashQuery(text)) return []
  return filterCommands(cmds, vue)
}
