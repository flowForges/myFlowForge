/**
 * 路由参数的归一化。**零 import** —— 这样它能被 `mobile` 那个 vitest project 收进去
 * (`environment: 'node'` + `include: ['mobile/src/**\/*.test.ts']`,一沾 React Native 就跑不了)。
 *
 * ★为什么单独放一份:`useLocalSearchParams()` 声明的类型是 `string`,实际却可能给回
 *  `string[]` —— 同一个参数名在 URL 里出现两次就是数组(深链是外面的世界拼的,
 *  `myflowforge://add-host?a=…&a=…` 谁都拦不住)。直接当字符串用会在运行时炸成
 *  「`addr.trim is not a function`」,而 TypeScript 一声不吭。
 *
 *  这段逻辑原来在 `mobile/app/add-host.tsx` 和 `mobile/app/exec.tsx` 里**各抄了一份**,
 *  而 `mobile/app/**` 根本不在测试的收集范围里 —— 两份都没人钉着。挪到这里就有了。
 */

/** 取一个参数的单值:数组取第一个,空数组和 `undefined` 都退化成空串。 */
export function one(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '')
}
