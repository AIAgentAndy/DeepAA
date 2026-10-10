import type {WireApi} from "@/types";

/**
 * 网关供应商在各 Agent 供应商列表中的统一分组显示名（2026-10-10 用户确认统一文案）。
 * 三协议 Agent（dsh / ZCode / OpenCode）共用同一映射，按协议分组展示模型；Codex
 * 官方仅支持 Responses 且保持无后缀主名「DeepAA 网关」，不参与本映射。
 *
 * 红线：该文案只写入各 Agent 配置文件的显示字段（dsh displayName / ZCode name 与
 * providerName / OpenCode name），绝不参与受管识别与清理——受管身份完全依赖 provider
 * 键命名空间（deepaa-gateway* / opencode-deepaa-gateway-* 等），改名靠每次同步全量
 * 重建受管块自然覆盖磁盘旧显示名。
 */
export const GATEWAY_PROVIDER_DISPLAY_NAMES: Readonly<Record<WireApi, string>> = {
  messages: "DeepAA 网关（Messages）",
  responses: "DeepAA 网关（Responses）",
  chat_completions: "DeepAA 网关（Chat Completions）",
};
