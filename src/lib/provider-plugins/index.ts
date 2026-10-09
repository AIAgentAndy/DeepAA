import type {SyncConnector, SyncProviderType} from "../sync-engine/types";
import {ManualAdapter} from "../sync-engine/adapters/manual";
import {DeepSeekAdapter} from "../sync-engine/adapters/deepseek";
import {MoonshotBalanceAdapter} from "../sync-engine/adapters/moonshot";
import {NoBalanceConsoleAdapter} from "../sync-engine/adapters/no-balance";
import {OpenRouterBalanceAdapter} from "../sync-engine/adapters/openrouter";
import {Sub2ApiAdapter} from "../sync-engine/adapters/sub2api";
import {RelayAdapter} from "../sync-engine/adapters/relay";
import {NewApiAdapter} from "../sync-engine/adapters/newapi";
import {ZhipuBalanceAdapter} from "../sync-engine/adapters/zhipu";

/**
 * Provider 插件的 server 装配点（docs/上线前架构升级改造.md P1-9）：
 * 余额适配器注册表的唯一构造位置。新增供应商的余额适配器只在这里登记一行
 * （无公开余额接口的供应商登记 NoBalanceConsoleAdapter）；套餐适配器注册表
 * 保持在 sync-engine/plan-registry.ts（它已满足单一装配点要求）。
 */
export function createBalanceConnectorRegistry(
  fetchImpl?: typeof fetch,
): Map<SyncProviderType, SyncConnector> {
  const adapters = new Map<SyncProviderType, SyncConnector>();
  // 中转站三件套 + 手动录入。
  adapters.set("newapi", new NewApiAdapter(fetchImpl));
  adapters.set("sub2api", new Sub2ApiAdapter(fetchImpl));
  adapters.set("relay", new RelayAdapter(fetchImpl));
  adapters.set("manual", new ManualAdapter());
  // 官方供应商：有公开余额接口的走专属适配器，其余统一 NoBalance。
  adapters.set("deepseek", new DeepSeekAdapter(fetchImpl));
  adapters.set("openai", new NoBalanceConsoleAdapter("openai"));
  adapters.set("anthropic", new NoBalanceConsoleAdapter("anthropic"));
  adapters.set("zhipu", new ZhipuBalanceAdapter(fetchImpl));
  adapters.set("kimi-coding", new MoonshotBalanceAdapter(fetchImpl));
  // MiniMax / 火山方舟暂无公开余额接口：账号信息可保存配置，余额需在官方控制台查看。
  adapters.set("minimax", new NoBalanceConsoleAdapter("minimax"));
  adapters.set("volcengine-plan", new NoBalanceConsoleAdapter("volcengine-plan"));
  adapters.set("openrouter", new OpenRouterBalanceAdapter(fetchImpl));
  // SiliconFlow 官方 /v1/user/info 已于 2026-08-14 下线且无替代接口（2026-09-29 调研确认）；
  // 降级为 NoBalance，官方发布替代账户接口后再恢复专属适配器。
  adapters.set("siliconflow", new NoBalanceConsoleAdapter("siliconflow"));
  adapters.set("qwenai", new NoBalanceConsoleAdapter("qwenai"));
  adapters.set("tencent-hunyuan", new NoBalanceConsoleAdapter("tencent-hunyuan"));
  adapters.set("opencode-go", new NoBalanceConsoleAdapter("opencode-go"));
  return adapters;
}
