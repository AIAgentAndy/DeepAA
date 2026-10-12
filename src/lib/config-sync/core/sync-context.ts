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
 * dsh 配置布局判定（两级探测）：任一信号命中即 profile-patch。
 * 1. settings.yaml.imported 迁移痕迹——dsh 0.1.7-rc.1+ 启动导入把 settings.yaml
 *    改名而来（此后不再有任何版本读取 settings.yaml）；
 * 2. $DSH_HOME/profiles/<name> 已初始化 profile 目录——只会由 ≥0.1.7 的 dsh 自身
 *    创建，存在即证明本机 dsh 读 profile patch 布局，且 dsh-hmr 对 cordis.patch.yml
 *    是文件监听 + 秒级热应用，写入立即生效、不依赖任何进程重启。
 *    仅靠 .imported 判定在「dsh web 先于 DeepAA 首次同步启动并常驻」的主流程会
 *    卡死：一次性导入只在进程启动时执行，常驻服务不重启就永远不产生 .imported，
 *    同步会一直写没有任何版本读取的 settings.yaml 死文件（2026-10-13 Windows 实测）。
 * 两者皆无 → legacy-settings（全新环境）：写 settings.yaml 由 dsh 首次启动导入进
 * 活跃 profile，.imported 出现后下次同步收敛到 profile patch，自愈闭环保留。
 * 显式注入优先（测试隔离）。
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
  if (existsSync(pathModule.join(dshHome, "settings.yaml.imported"))) return "profile-patch";
  // 与 resolveDshProfileNames 同一信号（目录由 dsh 自建、含完整骨架）。
  return DSH_KNOWN_PROFILES.some(name => existsSync(pathModule.join(dshHome, "profiles", name)))
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
