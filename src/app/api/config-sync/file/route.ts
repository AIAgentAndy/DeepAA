import {homedir} from "node:os";
import {join} from "node:path";
import {jsonResponse} from "@/lib/app-state";
import {
  defaultOverridesPath,
  defaultTemplatePath,
  readCatalogOverrides,
  readCatalogTemplate,
} from "@/lib/config-sync/catalog-template";
import {cliConfigAdapterFor} from "@/lib/config-sync/core/agent-plan-registry";
import {createCliSyncContext} from "@/lib/config-sync/core/sync-context";
import type {CliSyncPaths} from "@/lib/config-sync/core/types";
import {buildConfigFilePreview} from "@/lib/config-sync/file-preview";
import {readPricingEntriesByIdForSync} from "@/lib/config-sync/sync-manager";
import {assertLocalReadRequest, developmentLaunchErrorResponse} from "@/lib/development-launch/security";
import {resolveGatewayBaseUrl} from "@/lib/local-endpoints";
import {ProxyConfigStore} from "@/proxy-config";
import {KNOWN_AGENT_IDS, type AgentId} from "@/types";

export const dynamic = "force-dynamic";

const proxyConfig = new ProxyConfigStore();

/**
 * 单文件配置预览：fileId 只能命中服务端即时生成的 adapter 计划，浏览器不能提交本地路径。
 * 默认返回按文件格式局部隐藏敏感值的内容；只有用户显式传入 reveal=1 时才返回完整本地值。
 */
export async function GET(request: Request) {
  try {
    assertLocalReadRequest(request);
    const url = new URL(request.url);
    const fileId = url.searchParams.get("fileId")?.trim() || "";
    const targetId = url.searchParams.get("targetId")?.trim() || "";
    const revealSecrets = url.searchParams.get("reveal") === "1";
    const agent = fileId.split(":", 1)[0] || "";
    if (!fileId || !targetId || !KNOWN_AGENT_IDS.includes(agent as AgentId)) {
      return jsonResponse({ok: false, error: "CONFIG_FILE_PREVIEW_INVALID", message: "受管配置文件标识无效"}, 400);
    }

    await proxyConfig.reload();
    const config = proxyConfig.getConfig();
    if (!config.targets.some(target => target.id === targetId)) {
      return jsonResponse({ok: false, error: "TARGET_NOT_FOUND", message: "当前供应商不存在"}, 404);
    }
    const paths = defaultPaths(config.localProxyBaseUrl);
    const template = await readCatalogTemplate(defaultTemplatePath());
    const overrides = await readCatalogOverrides(defaultOverridesPath());
    const pricingEntriesById = await readPricingEntriesByIdForSync();
    const context = createCliSyncContext({config, paths, template, overrides, ...(pricingEntriesById ? {pricingEntriesById} : {})});
    const adapter = cliConfigAdapterFor(agent as AgentId);
    const plan = adapter.build(context, adapter.resolvePaths(context));
    adapter.validate(plan);
    const file = await buildConfigFilePreview({
      adapter,
      plan,
      fileId,
      defaultTargetId: config.agentConnections[adapter.agent]?.defaultTargetId,
      currentTargetId: targetId,
      revealSecrets,
    });
    if (!file) {
      return jsonResponse({ok: false, error: "CONFIG_FILE_NOT_FOUND", message: "受管配置文件不存在或已失效"}, 404);
    }
    return jsonResponse({ok: true, file}, 200, {"Cache-Control": "no-store"});
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}

function defaultPaths(localProxyBaseUrl?: string): CliSyncPaths {
  const home = homedir();
  return {
    codexConfigPath: join(home, ".codex", "config.toml"),
    codexCatalogPath: join(home, ".codex", "deepaa", "catalogs", "all.json"),
    claudeUserSettingsPath: join(home, ".claude", "settings.json"),
    claudeProjectSettingsPaths: {},
    gatewayBaseUrl: resolveGatewayBaseUrl(localProxyBaseUrl),
    gatewayBearerToken: "deepaa-gateway",
  };
}
