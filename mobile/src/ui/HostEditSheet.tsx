import { useEffect, useRef, useState } from 'react'
import { Pressable, View } from 'react-native'
import { useC } from '../theme/theme'
import { Btn, Field, T } from './kit'
import { Sheet } from './Sheet'
import { HOST_ICONS, currentHostIcon } from '../net/hostIcons'

/**
 * 改一台主机的**名字和图标**。★**只此一份** —— 现在有三个地方要用它。
 *
 * ★★为什么抽出来:2026-09-03 之前它是 `app/hosts.tsx` 里的一段内联 JSX,而**长按那一行是
 *  唯一的入口**。用户当场问了三句:「主机列表里为什么不能改名称和图标?」「设置里为什么只能
 *  长按修改?」「点击进去为什么不支持修改?」—— 三句话是同一件事:**改名这件事只有一个
 *  看不见的手势能碰到**。这个仓库在「看不见的手势」上已经栽过一次(首页那个长按左滑)。
 *  现在的入口:
 *   ① 主机详情页里一行**看得见的**「名称与图标」(点进去就能改,正面回答那第三句);
 *   ② 首页左上角那张换主机的单子里,长按一行;
 *   ③ 设置 → 主机 列表里,长按一行(原来那个,保留)。
 *
 * ★名字和图标**只存在这台手机上**,不发给那台电脑 —— 所以没连着的主机照样能改,
 *  改完也不会把正在跑的连接踢掉。这句话在单子上写着,不是只写在这儿。
 */
export type HostEditTarget = { id: string; label: string; icon: string }

export function HostEditSheet({
  target,
  onClose,
  onSave,
}: {
  /** 正在编哪一台。`null` = 单子关着。 */
  target: HostEditTarget | null
  onClose: () => void
  onSave: (id: string, patch: { label: string; icon: string }) => Promise<void> | void
}) {
  const c = useC()
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('')

  /**
   * 换一台主机(或者从关着变成打开)→ 把草稿归零成**那一台**的当前值。
   *
   * ★★这个 effect 不是多余的防御:`Sheet` 关掉时**不卸载**(要留住关闭动画),所以内部
   *  state 会活到下一次打开。不归零的话,连着编第二台会带着上一台的名字进来 ——
   *  这个仓库在建区向导上栽过一模一样的坑(弹窗只 `return null` 不卸载,新加的 state
   *  必须在 reset effect 里归零)。
   * ★按 `id` 判而不是按对象引用:父组件每次渲染都会造一个新对象,按引用判会在打字过程中
   *  把你正在输入的名字冲掉。
   */
  const lastId = useRef<string | null>(null)
  useEffect(() => {
    if (!target) { lastId.current = null; return }
    if (lastId.current === target.id) return
    lastId.current = target.id
    setName(target.label)
    setIcon(currentHostIcon(target.icon))
  }, [target])

  /**
   * ★图标和名字**一起提交**(一次写盘),不是点一下图标就存一次:那样「取消」就没有意义了,
   *  而且连点几下会连写几次 AsyncStorage。
   */
  const submit = async () => {
    if (!target) return
    await onSave(target.id, { label: name, icon })
    onClose()
  }

  return (
    <Sheet
      open={!!target}
      onClose={onClose}
      title="编辑主机"
      // 打开那一刻的原名、**只读**:输入框一开始改就不再回答「我改的是哪一台」了,
      // 而长按呼出这张单子的时候,人未必记得刚才按的是哪行。
      sub={`${target?.label ?? ''}\n名字和图标只存在这台手机上,不会发给那台电脑`}
    >
      {/* ★★图标在名字**上面**:它是一眼能点完的事(六选一),而名字要唤起键盘 ——
          反过来摆的话,键盘一升起来正好把图标那一行盖掉。 */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 2 }}>
        {HOST_ICONS.map((o) => {
          const on = o.icon === icon
          return (
            <Pressable
              key={o.icon}
              onPress={() => setIcon(o.icon)}
              accessibilityLabel={o.label}
              accessibilityState={{ selected: on }}
              style={{ alignItems: 'center', gap: 4, paddingVertical: 6, width: 50 }}
            >
              <View
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 12,
                  alignItems: 'center',
                  justifyContent: 'center',
                  // 选中态和权限档那个 sheet 同一套写法:描边换成强调色 + 底色提亮。
                  borderWidth: on ? 2 : 1,
                  borderColor: on ? c.accent : c.border2,
                  backgroundColor: on ? c.accentDim : c.bg2,
                }}
              >
                <T style={{ fontSize: 20 }}>{o.icon}</T>
              </View>
              <T numberOfLines={1} style={{ fontSize: 10.5, color: on ? c.accent : c.faint }}>
                {o.label}
              </T>
            </Pressable>
          )
        })}
      </View>

      <Field
        value={name}
        onChangeText={setName}
        placeholder="书房的 Mac(不填就用地址)"
        autoCapitalize="none"
        onSubmitEditing={() => void submit()}
      />
      {/* ★这里**不**像重命名工作区那样 `disabled={!name.trim()}`:那边空名会在服务端落成一个
          没名字的工作区,这边空名有明确含义 —— 回落成地址(`hostLabel`),那是一个合法的选择。 */}
      <Btn kind="pri" block onPress={() => void submit()}>
        保存
      </Btn>
    </Sheet>
  )
}
