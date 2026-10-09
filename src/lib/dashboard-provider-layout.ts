/**
 * 判断仪表盘供应商卡右侧同步列是否需要堆叠。
 *
 * `balanceRight` 与 `syncLeft` 来自同一张卡片的 DOM 边界：
 * - 小于 0：余额胶囊已经溢入同步列；
 * - 0～5：两者间距过近，继续横排会产生视觉粘连；
 * - 大于 5：保留原有横排，避免大多数正常卡片发生无意义变化。
 */
export function shouldStackProviderSync({
  balanceRight,
  syncLeft,
  threshold = 5,
}: {
  balanceRight: number;
  syncLeft: number;
  threshold?: number;
}): boolean {
  if (!Number.isFinite(balanceRight) || !Number.isFinite(syncLeft)) return false;
  return syncLeft - balanceRight <= threshold;
}
