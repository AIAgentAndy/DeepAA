"use client";

import styles from "./proxy-management.module.css";

/**
 * 向导「接入 Agent」步骤的直连观测提示（2026-10-10 用户确认文案收敛）：
 * 智谱 Coding Plan 官方预设 + 所选/已接入 Agent 含 zcode 时展示一句话口径，
 * 引导用户「ZCode 内使用官方自带模型直连享套餐积分折扣」。
 * 「密钥与模型」页签不再展示（用户确认）；基础信息页签「套餐用量」标题下的
 * 常驻详述见 ProxyOverviewTab 的 planDirectObserveNote 段落。其它预设不渲染。
 */
export function ZcodeLocalImportHint(props: {
  presetId?: string;
  agents: readonly string[];
}) {
  if (props.presetId !== "zhipu-coding-plan") return null;
  if (!props.agents.includes("zcode")) return null;
  return (
    <p className={styles.wizardStepDesc} data-testid="zcode-local-import-hint">
      <strong>官方直连观测：</strong>
      为了享用智谱官方的套餐积分折扣，智谱官方限制只能在他们自己的 ZCode 客户端才能享用，请关注使用。
    </p>
  );
}
