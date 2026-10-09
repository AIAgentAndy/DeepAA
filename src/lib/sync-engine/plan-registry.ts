import type {PlanProviderType, PlanSyncConnector} from "./types";
import {KimiCodingPlanAdapter} from "./adapters/plan/kimi-coding";
import {ZhipuPlanAdapter} from "./adapters/plan/zhipu";
import {MiniMaxPlanAdapter} from "./adapters/plan/minimax";
import {VolcenginePlanAdapter} from "./adapters/plan/volcengine-plan";
import {VolcengineCodingPlanAdapter} from "./adapters/plan/volcengine-coding-plan";
import {QwenAiTokenPlanAdapter} from "./adapters/plan/qwenai-token-plan";
import {TencentTokenHubPlanAdapter} from "./adapters/plan/tencent-tokenhub-plan";
import {OpenCodeGoPlanAdapter} from "./adapters/plan/opencode-go";
import {OpenAiSubscriptionPlanAdapter} from "./adapters/plan/openai-subscription";
import {AnthropicSubscriptionPlanAdapter} from "./adapters/plan/anthropic-subscription";

/** 注册表是套餐适配器唯一装配点；新增供应商不修改调度框架。 */
export function createPlanAdapterRegistry(
  options: {
    fetchImpl?: typeof fetch;
    /** 订阅适配器只读 Codex auth.json 的目录（测试注入用；缺省使用真实 HOME）。 */
    codexHome?: string;
    /** 订阅适配器只读 Claude 凭据的目录（测试注入用；缺省使用真实 HOME）。 */
    claudeHome?: string;
  } | typeof fetch = {},
): Map<PlanProviderType, PlanSyncConnector> {
  // 原始注入值（可能为 undefined）单独保留给订阅适配器：其内部对官方上游域
  // 探测到系统代理时走 CONNECT 隧道（fetchOfficialUsage），只有显式注入
  // （测试 mock）才直连注入实现——此前 `|| fetch` 规范化把「未注入」也变成
  // 全局 fetch，导致隧道路径在生产 SyncService 装配下永远不生效
  // （2026-10-09 PLAN_FETCH_FAILED_UND_ERR_CONNECT_TIMEOUT 事故根因）。
  const rawFetchImpl = typeof options === "function" ? options : options.fetchImpl;
  const fetchImpl = rawFetchImpl || fetch;
  const codexHome = typeof options === "function" ? undefined : options.codexHome;
  const claudeHome = typeof options === "function" ? undefined : options.claudeHome;
  return new Map<PlanProviderType, PlanSyncConnector>([
    ["kimi-coding", new KimiCodingPlanAdapter(fetchImpl)],
    ["zhipu", new ZhipuPlanAdapter(fetchImpl)],
    ["minimax", new MiniMaxPlanAdapter(fetchImpl)],
    ["volcengine-plan", new VolcenginePlanAdapter(fetchImpl)],
    ["volcengine-coding-plan", new VolcengineCodingPlanAdapter(fetchImpl)],
    ["qwenai-token-plan", new QwenAiTokenPlanAdapter(fetchImpl)],
    ["tencent-tokenhub-plan", new TencentTokenHubPlanAdapter(fetchImpl)],
    ["opencode-go", new OpenCodeGoPlanAdapter(fetchImpl)],
    ["openai-subscription", new OpenAiSubscriptionPlanAdapter({codexHome, fetchImpl: rawFetchImpl})],
    ["anthropic-subscription", new AnthropicSubscriptionPlanAdapter({claudeHome, fetchImpl: rawFetchImpl})],
  ]);
}
