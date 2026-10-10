/**
 * VPN 隧道模型门控（2026-10-10 用户确认）。
 *
 * 模型门控域（opencode.ai / openrouter.ai）host 直连可达，但对国外系模型存在
 * 模型级地域封锁（用户实测：国产模型直连 OK，gpt/claude/gemini/grok 系直连
 * 被拒、开 VPN 正常）。本模块按模型 ID 前缀判定该请求是否需要经 VPN 隧道。
 *
 * 家族口径镜像 src/lib/model-family.ts 的共有家族（gpt 含 o 系列/claude/grok，
 * 含 openrouter 风格命名空间前缀剥离），由 tests/upstream-model-gate.test.ts
 * 守卫锁定一致；gemini 与 chatgpt 为本模块扩展项（model-family 无此家族）。
 * 代理 bundle 不得导入 web 侧模块（边界红线），故按项目惯例做注册表镜像。
 */

/** 需要经 VPN 隧道出站的模型名前缀（小写裸模型 ID；扩展时加一行）。 */
const VPN_TUNNEL_MODEL_PREFIXES = [
  "gpt-",
  "chatgpt-",
  "claude-",
  "anthropic",
  "grok",
  "gemini",
] as const;

/** 模型是否需要经 VPN 隧道出站；无模型（如 web 侧用量 GET）判 false 走直连。 */
export function isVpnTunnelModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const model = modelId.trim().toLowerCase();
  if (!model) return false;
  // openrouter 风格命名空间前缀（vendor/model）剥后再判，与 model-family.ts 对齐。
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  if (VPN_TUNNEL_MODEL_PREFIXES.some(prefix => bare.startsWith(prefix))) return true;
  // o 系列（o1/o3/o4-mini…）是 gpt 家族的无 gpt 文案变体，正则与 model-family.ts 同款。
  return /^o[1-9](?:[-.]|$)/u.test(bare);
}
