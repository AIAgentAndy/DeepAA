/**
 * Agent → 官方直连导入预设映射（client-safe：供 UI 组件渲染判定，零服务端依赖）。
 * 绑定推导（binding.ts）与 UI 共用此单一来源，防止两边口径漂移。
 */

import type { AgentId } from "@/types";

/** Agent → 官方预设映射（zcode → 智谱 Coding Plan；dsh → DeepSeek 官方按量；codex → OpenAI 订阅）。 */
const AGENT_OFFICIAL_PRESET: Partial<Record<AgentId, string>> = {
  zcode: "zhipu-coding-plan",
  dsh: "deepseek",
  codex: "openai-subscription",
};

/** 该 Agent 声明的官方直连导入预设；未声明 = 该 Agent 无此能力。 */
export function localImportPresetForAgent(agentId: AgentId): string | undefined {
  return AGENT_OFFICIAL_PRESET[agentId];
}

/** 「官方直连观测」状态区说明文案（按 Agent 分化，2026-10-09 用户确认：
 * chatgpt 的原因是 OpenAI 登录协议限制而非积分折扣，不得复用 ZCode 口径）。 */
export interface LocalImportStatusCopy {
  /** 直连导入态（directImportEnabled）文案。 */
  direct: string;
  /** 仅身份标注模式（directImportEnabled=false，当前仅 dsh）文案。 */
  identityOnly: string;
}

const IDENTITY_ONLY_TAIL = "——本地日志仍按固定节奏扫描，只把原生会话/轮次/步骤身份回填给经网关的捕获行，不再单独入账（网关 raw 记录更完整）。";

const LOCAL_IMPORT_STATUS_COPY: Partial<Record<AgentId, LocalImportStatusCopy>> = {
  zcode: {
    direct: "ZCode 内使用官方自带模型直连时（享官方积分折扣，官方按客户端签名认定），该部分请求由本能力自动导入观测与账本（最多回看一个月），无需任何手动操作；经本网关的请求不受影响。",
    identityOnly: `ZCode 当前为「仅身份标注」模式${IDENTITY_ONLY_TAIL}`,
  },
  codex: {
    direct: "Codex 以 ChatGPT 登录原生使用官方模型时（因 OpenAI 登录协议限制，该部分请求无法经本网关路由），由本能力自动导入观测与账本（最多回看一个月），无需任何手动操作；经本网关的请求不受影响。",
    identityOnly: `Codex 当前为「仅身份标注」模式${IDENTITY_ONLY_TAIL}`,
  },
  dsh: {
    direct: "dsh 直连官方的请求由本能力自动导入观测与账本（最多回看一个月），无需任何手动操作；经本网关的请求不受影响。",
    identityOnly: `dsh 为「仅身份标注」模式${IDENTITY_ONLY_TAIL}`,
  },
};

/** 状态区说明文案：按 Agent 查声明表；未登记 Agent 回退通用表述（防御，正常不触达）。 */
export function localImportStatusCopyForAgent(agentId: AgentId): LocalImportStatusCopy {
  return LOCAL_IMPORT_STATUS_COPY[agentId] ?? {
    direct: "该 Agent 使用官方自带模型直连时，该部分请求由本能力自动导入观测与账本（最多回看一个月）；经本网关的请求不受影响。",
    identityOnly: `该 Agent 当前为「仅身份标注」模式${IDENTITY_ONLY_TAIL}`,
  };
}

/**
 * UI 渲染判定：该 Agent 声明了本地导入适配即展示状态区（2026-10-06 与默认目标
 * 解耦——归因目标按候选扫描推导，默认目标指向第三方时状态区不能整块消失，
 * 绑定是否成立、归因到哪个目标由接口如实展示）。
 */
export function hasLocalImportAdapter(agentId: AgentId): boolean {
  return AGENT_OFFICIAL_PRESET[agentId] !== undefined;
}
