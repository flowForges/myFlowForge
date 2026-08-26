/**
 * 「已归档的工作区」屏要的那一份纯逻辑:从全量工作区列表里挑出归档的,按归档时间倒序
 * (最近归档的排最前)。
 *
 * ★单独拎出来是因为 `mobile/app/archived.tsx` 不带 RN 的那一半(vitest 的 `mobile` project
 *  只收不 import react-native 的文件,见根目录 `vitest.config.ts` 的注释)测不了,这个文件能测。
 */
export function orderArchived<T extends { archived: boolean; archivedAt: number | null }>(all: T[]): T[] {
  // ★`archivedAt` 拿的是 `WorkspaceMeta.archivedAt`(`number | null`)—— 缺失一律当 0,
  //  排到最后而不是让 NaN/undefined 把整个排序弄乱。
  return all.filter((w) => w.archived).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
}
