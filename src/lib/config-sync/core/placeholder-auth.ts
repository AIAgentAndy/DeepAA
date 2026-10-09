/**
 * 本地网关占位凭据与密钥红线校验。
 *
 * 所有受管 CLI 配置只允许出现 deepaa-gateway 占位 token，
 * 真实供应商密钥只存在于系统凭据库，绝不进入配置文件、LaunchPlan 或日志。
 */

export const GATEWAY_PROVIDER_ID = "deepaa_gateway";
export const GATEWAY_PLACEHOLDER_TOKEN = "deepaa-gateway";

/** OpenCode 受管 provider ID 前缀；命中该前缀的最新 OpenCode 才会发送 x-opencode-* 身份头。 */
export const OPENCODE_PROVIDER_PREFIX = "opencode-deepaa-gateway";
export const OPENCODE_PROVIDERS = [
  "opencode-deepaa-gateway-responses",
  "opencode-deepaa-gateway-chat",
  "opencode-deepaa-gateway-anthropic",
] as const;

/** dsh 受管配置读取本地占位 token 的环境变量名。 */
export const DSH_API_KEY_ENV = "DEEPAA_GATEWAY_TOKEN";

const REAL_SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{12,}/u,
  /Bearer\s+[A-Za-z0-9._~+/=-]{24,}/u,
  /eyJ[A-Za-z0-9_-]{20,}/u,
  /secret-token/iu,
  /api[_-]?key\s*[=:]\s*[^\s,{}"]{16,}/iu,
  /auth[_-]?token\s*[=:]\s*[^\s,{}"]{16,}/iu,
  /access[_-]?token\s*[=:]\s*[^\s,{}"]{16,}/iu,
];

/**
 * 校验待写内容只含本地网关占位 token，不含真实供应商密钥。
 * 先把占位 token 归一化剔除，避免 apiKey 模式误伤受管配置。
 */
export function assertNoRealSecrets(content: string, source = "CLI 配置"): void {
  const normalized = content.split(GATEWAY_PLACEHOLDER_TOKEN).join("");
  for (const pattern of REAL_SECRET_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new Error(`SECRET_IN_CLI_CONFIG: ${source} 疑似包含真实密钥，已拒绝写入`);
    }
  }
}
