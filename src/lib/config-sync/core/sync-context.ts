import {homedir} from "node:os";
import {existsSync} from "node:fs";
import {posix, win32} from "node:path";
import {GATEWAY_PLACEHOLDER_TOKEN} from "@/lib/config-sync/core/placeholder-auth";
import type {
  CliSyncContext,
  CliSyncPaths,
  DshConfigLayout,
} from "@/lib/config-sync/core/types";
import type {CatalogOverrides, CatalogTemplate} from "@/lib/config-sync/catalog-template";
import type {ModelPriceEntry} from "@/lib/pricing";
import {resolveGatewayBaseUrl} from "@/lib/local-endpoints";
import type {ProxyConfig} from "@/types";

/** $DSH_HOME 环境变量优先，缺省 ~/.dsh；按平台选路径分隔规则（dsh 适配器共用）。 */
export function resolveDshHomeDir(input: {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): string {
  const pathModule = input.platform === "win32" ? win32 : posix;
  const dshHome = input.env.DSH_HOME?.trim();
  return dshHome || pathModule.join(input.homeDir, ".dsh");
}

/** dsh 受管配置涉及的 profile（dsh web 桌面 Web 服务 / Desktop 客户端独占 profile）。 */
const DSH_KNOWN_PROFILES = ["web", "desktop"] as const;

/**
 * dsh 配置布局判定：settings.yaml.imported 是 dsh 0.1.7-rc.1+ 完成一次性迁移的
 * 唯一可靠痕迹（导入把 settings.yaml 改名后不再有任何版本读取它）。显式注入
 * 优先（测试隔离）；探测失败/无痕迹一律保守回落 legacy-settings——全新 0.2.x
 * 环境首次写 settings.yaml 会被 dsh 启动导入进活跃 profile（受管分节随迁生效），
 * .imported 出现后下一次同步自动切换 profile patch，自愈闭环。
 */
function resolveDshConfigLayout(input: {
  paths: CliSyncPaths;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): DshConfigLayout {
  const injected = input.paths.dshConfigLayout;
  if (injected) return injected;
  // 注入 profile patch 路径即显式表达按 patch 布局同步（测试隔离位）。
  if (input.paths.dshProfilePatchPaths && Object.keys(input.paths.dshProfilePatchPaths).length > 0) {
    return "profile-patch";
  }
  const pathModule = input.platform === "win32" ? win32 : posix;
  const injectedSettings = input.paths.dshSettingsPath?.trim();
  const dshHome = injectedSettings
    ? pathModule.dirname(injectedSettings)
    : resolveDshHomeDir(input);
  return existsSync(pathModule.join(dshHome, "settings.yaml.imported"))
    ? "profile-patch"
    : "legacy-settings";
}

/**
 * 探测已初始化的 dsh profile：只有目录已存在（由 dsh 自身创建，含完整骨架）的
 * profile 才允许写受管 patch，绝不凭空创建目录。显式注入优先（测试隔离）。
 */
function resolveDshProfileNames(input: {
  paths: CliSyncPaths;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): readonly string[] {
  const injected = input.paths.dshProfilePatchPaths;
  if (injected && Object.keys(injected).length > 0) {
    return Object.keys(injected);
  }
  const pathModule = input.platform === "win32" ? win32 : posix;
  const dshHome = resolveDshHomeDir(input);
  return DSH_KNOWN_PROFILES.filter(name => {
    try {
      return existsSync(pathModule.join(dshHome, "profiles", name));
    } catch {
      return false;
    }
  });
}

/** 构建公共同步上下文；gatewayBaseUrl / bearerToken 统一归一化与兜底。 */
export function createCliSyncContext(options: {
  config: ProxyConfig;
  paths: CliSyncPaths;
  template: CatalogTemplate;
  overrides: CatalogOverrides;
  /** 价格中心条目索引（可选）：供共享解析层按 priceEntryId 精确命中；缺省跳过该级。 */
  pricingEntriesById?: ReadonlyMap<string, ModelPriceEntry>;
  /** 本机 Claude CLI 登录态（可选）：由 sync-manager 编排层探测注入；缺省视为未登录。 */
  cliLogin?: {claude: boolean};
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): CliSyncContext {
  const homeDir = options.homeDir || homedir();
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  // 全站统一 127.0.0.1：存量 localhost 别名在写盘前的唯一收敛点归一化。
  const gatewayBaseUrl = resolveGatewayBaseUrl(options.paths.gatewayBaseUrl);
  const gatewayBearerToken = options.paths.gatewayBearerToken || GATEWAY_PLACEHOLDER_TOKEN;
  return {
    config: options.config,
    paths: options.paths,
    template: options.template,
    overrides: options.overrides,
    ...(options.pricingEntriesById ? {pricingEntriesById: options.pricingEntriesById} : {}),
    ...(options.cliLogin ? {cliLogin: options.cliLogin} : {}),
    homeDir,
    env,
    platform,
    gatewayBaseUrl,
    gatewayBearerToken,
    dshConfigLayout: resolveDshConfigLayout({
      paths: options.paths,
      homeDir,
      env,
      platform,
    }),
    dshProfileNames: resolveDshProfileNames({
      paths: options.paths,
      homeDir,
      env,
      platform,
    }),
  };
}
