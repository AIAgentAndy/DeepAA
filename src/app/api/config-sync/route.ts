import {homedir} from "node:os";
import {join} from "node:path";
import {jsonResponse} from "@/lib/app-state";
import {
  readCatalogOverrides,
  readCatalogTemplate,
  defaultTemplatePath,
  defaultOverridesPath,
} from "@/lib/config-sync/catalog-template";
import {cliConfigAdapters} from "@/lib/config-sync/core/agent-plan-registry";
import {createCliSyncContext} from "@/lib/config-sync/core/sync-context";
import type {CliSyncPaths} from "@/lib/config-sync/core/types";
import type {ConfigFileDisplayManifest} from "@/lib/config-sync/file-display";
import {buildAgentFileManifests} from "@/lib/config-sync/file-preview";
import {
  readPricingEntriesByIdForSync,
  syncCliConfigs,
  type ConfigSyncReport,
} from "@/lib/config-sync/sync-manager";
import {ProxyConfigStore} from "@/proxy-config";
import {resolveGatewayBaseUrl} from "@/lib/local-endpoints";
import {
  assertLocalMutationRequest,
  developmentLaunchErrorResponse,
  getLaunchNonceStore,
  readBoundedJson,
  requireLaunchNonce,
} from "@/lib/development-launch/security";

export const dynamic = "force-dynamic";

const proxyConfig = new ProxyConfigStore();

function defaultPaths(projectSettingsPaths: Record<string, string> = {}, localProxyBaseUrl?: string): CliSyncPaths {
  const home = homedir();
  return {
    codexConfigPath: join(home, ".codex", "config.toml"),
    codexCatalogPath: join(home, ".codex", "deepaa", "catalogs", "all.json"),
    claudeUserSettingsPath: join(home, ".claude", "settings.json"),
    claudeProjectSettingsPaths: projectSettingsPaths,
    gatewayBaseUrl: resolveGatewayBaseUrl(localProxyBaseUrl),
    gatewayBearerToken: "deepaa-gateway",
  };
}

/**
 * 首屏预览只生成不落盘：返回 Agent 摘要与不含正文的受管文件 manifest。
 * 供应商贡献和服务端脱敏正文只在用户展开单个文件时由 /api/config-sync/file 计算。
 */
export async function GET(request?: Request) {
  // 保留可选 Request 形参，便于 Next 路由调用和安全测试直接调用同一入口。
  void request;
  await proxyConfig.reload();
  const config = proxyConfig.getConfig();
  const paths = defaultPaths(undefined, config.localProxyBaseUrl);
  const template = await readCatalogTemplate(defaultTemplatePath());
  const overrides = await readCatalogOverrides(defaultOverridesPath());
  const pricingEntriesById = await readPricingEntriesByIdForSync();
  const context = createCliSyncContext({config, paths, template, overrides, ...(pricingEntriesById ? {pricingEntriesById} : {})});
  const previews: Record<string, unknown> = {};
  const warnings: CliSyncReportWarning[] = [];
  const resolvedPaths: Record<string, string> = {};
  const fileDisplays: Partial<Record<string, ConfigFileDisplayManifest[]>> = {};
  for (const adapter of cliConfigAdapters()) {
    try {
      const resolved = adapter.resolvePaths(context);
      const plan = adapter.build(context, resolved);
      adapter.validate(plan);
      previews[adapter.agent] = adapter.describe(plan);
      warnings.push(...plan.warnings);
      for (const [specId, filePath] of Object.entries(resolved.filePaths)) {
        resolvedPaths[`${adapter.agent}:${specId}`] = filePath;
      }
      // Agent 接入页首屏只返回 manifest；正文必须由单文件 API 按需读取并服务端脱敏。
      fileDisplays[adapter.agent] = await buildAgentFileManifests({adapter, plan});
    } catch (error) {
      previews[adapter.agent] = {
        agent: adapter.agent,
        active: false,
        files: [],
        warnings: [],
        notes: [],
      };
      fileDisplays[adapter.agent] = [];
      warnings.push({
        targetId: adapter.agent,
        code: "ADAPTER_WARNING",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return jsonResponse({
    ok: true,
    warnings,
    previews,
    fileDisplays,
    paths: {
      codexConfigPath: paths.codexConfigPath,
      codexCatalogPath: paths.codexCatalogPath,
      claudeUserSettingsPath: paths.claudeUserSettingsPath,
      ...(resolvedPaths["opencode:opencode-global"] ? {opencodeConfigPath: resolvedPaths["opencode:opencode-global"]} : {}),
      ...(resolvedPaths["dsh:dsh-settings"] ? {dshSettingsPath: resolvedPaths["dsh:dsh-settings"]} : {}),
      ...(resolvedPaths["zcode:zcode-config"] ? {zcodeConfigPath: resolvedPaths["zcode:zcode-config"]} : {}),
    },
    nonce: getLaunchNonceStore().issue(),
  });
}

type CliSyncReportWarning = {
  targetId: string;
  code: string;
  message: string;
};

export async function POST(request: Request) {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    requireLaunchNonce(body);
    await proxyConfig.reload();
    const paths = defaultPaths(
      normalizeProjectSettingsPaths(body.projectSettingsPaths),
      proxyConfig.getConfig().localProxyBaseUrl,
    );
    const credentialHelperPath = join(process.cwd(), "bin", "credential-helper.mjs");
    const report: ConfigSyncReport = await syncCliConfigs(proxyConfig.getConfig(), {
      paths,
      credentialHelperPath,
    });
    return jsonResponse({...report, nonce: getLaunchNonceStore().issue()}, report.ok ? 200 : 500);
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}

function normalizeProjectSettingsPaths(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  let count = 0;
  for (const [projectDir, settingsPath] of Object.entries(value as Record<string, unknown>)) {
    if (count >= 50) break;
    if (typeof projectDir !== "string" || projectDir.length === 0 || projectDir.length > 4096) continue;
    if (typeof settingsPath !== "string" || settingsPath.length === 0 || settingsPath.length > 4096) continue;
    result[projectDir] = settingsPath;
    count += 1;
  }
  return result;
}
