"use client";

import styles from "./proxy-management.module.css";

/**
 * 双链路观测提示（2026-09-15）：智谱 Coding Plan 官方预设 + 绑定 zcode 时展示，
 * 引导用户「ZCode 内使用官方自带模型直连享积分折扣」，并说明该部分流量由
 * 本地导入自动纳入观测与账本（无手动操作）。其它预设/Agent 组合不渲染。
 */
export function ZcodeLocalImportHint(props: {
  presetId?: string;
  agents: readonly string[];
  variant?: "wizard" | "tab";
}) {
  if (props.presetId !== "zhipu-coding-plan") return null;
  if (!props.agents.includes("zcode")) return null;
  return (
    <p className={styles.wizardStepDesc} data-testid="zcode-local-import-hint">
      <strong>官方直连观测：</strong>
      为了享用官方 ZCode 的积分折扣，使用 ZCode 工作时，请选择 ZCode 官方自带模型即可。
      该部分请求不经过本网关，由 DeepAA 以 5 秒节奏自动导入本地观测与账本（最多回看一个月），
      无需任何手动操作；经本网关转发的请求不受影响（官方按 ZCode 客户端签名认定，
      经网关流量不享受折扣，账本会如实区分两种来源）。
    </p>
  );
}
