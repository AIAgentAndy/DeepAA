import {
  isModelAllowedForAgent,
  isModelWireApiAllowedForAgent,
  resolveCredentialForAgent,
  type RoutingSnapshot,
  type RoutingTarget,
} from "./routing-config.js";
import {parseGatewayModelId} from "./gateway-prefix.js";
import {
  agentBindingForPath,
  bindingSupportsSubscription,
} from "@/lib/agent-registry";
import type {WireApi} from "@/types";

export type GatewayRouteErrorCode =
  | "INVALID_ROUTE"
  | "MODEL_PREFIX_REQUIRED"
  | "TARGET_NOT_FOUND"
  | "PROTOCOL_MISMATCH"
  | "MODEL_NOT_ALLOWED"
  | "CREDENTIAL_NOT_CONFIGURED"
  | "MODEL_WIRE_API_UNSUPPORTED"
  | "SUBSCRIPTION_PASSTHROUGH_UNSUPPORTED";

export class GatewayRouteError extends Error {
  readonly code: GatewayRouteErrorCode;

  constructor(code: GatewayRouteErrorCode) {
    super(code);
    this.name = "GatewayRouteError";
    this.code = code;
  }
}

export interface GatewayRouteDecision {
  target: RoutingTarget;
  modelId: string;
  requestedModel: string;
  /** 请求来源 Agent（由 /{agent}/v1 路径解析）。 */
  agent: GatewayAgent;
  /** 凭据处理模式：passthrough 透传客户端 Authorization（订阅通道），inject 从系统凭据库注入。 */
  credentialMode: "passthrough" | "inject";
  /** 注入模式下该 Agent 命中的默认凭据引用；透传模式下为 undefined。 */
  credentialId?: string;
  upstreamPath: string;
  /** 按请求路径选定的协议上游 URL。 */
  upstreamUrl: string;
  /** 请求路径命中的真实 wire API。 */
  wireApi: WireApi;
}

import {AGENT_REGISTRY, isKnownGatewayAgent} from "@/lib/agent-registry";
import type {AgentId} from "@/types";

/** 网关当前支持的 Agent 标识；由 Agent 注册表推导，未来 Agent 在注册表扩展。 */
export const GATEWAY_AGENTS: readonly AgentId[] = AGENT_REGISTRY.map(item => item.id);
export type GatewayAgent = AgentId;

export interface GatewayAgentPath {
  agent: GatewayAgent;
  /** 剥离 agent 段后的协议路径，例如 /v1/responses。 */
  protocolPath: string;
}

/**
 * 解析网关 Agent 路径：/{agent}/v1/{协议路径}。
 * 无 agent 段的历史路径（/v1/...）一律返回 null（项目未上线，不做旧格式兼容）。
 */
export function parseGatewayAgentPath(pathname: string): GatewayAgentPath | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const agent = segments[0]!;
  if (!isKnownGatewayAgent(agent)) return null;
  if (segments[1] !== "v1") return null;
  return {
    agent,
    protocolPath: `/${segments.slice(1).join("/")}`,
  };
}

/** 判断是否为网关支持的请求路径；协议路径必须命中该 Agent 注册的 binding。 */
export function isGatewayPostPath(pathname: string): boolean {
  const parsed = parseGatewayAgentPath(pathname);
  if (!parsed) return false;
  return agentBindingForPath(parsed.agent, parsed.protocolPath) !== undefined;
}

export function isGatewayModelsPath(pathname: string): boolean {
  const parsed = parseGatewayAgentPath(pathname);
  return parsed !== null && parsed.protocolPath === "/v1/models";
}

/**
 * 根据请求路径与带前缀模型 ID 决策网关路由：
 * Agent 由 /{agent}/v1 路径确定（注册表 binding 声明协议；codex 只允许 openai，
 * claude 只允许 anthropic，opencode 三种 binding，dsh 只允许 chat_completions），
 * 供应商由模型前缀唯一确定，模型必须命中供应商白名单且适用含该 Agent，
 * 凭据按 Agent 级默认密钥解析；Agent UI 接入状态不参与网关权限判断。
 */
export function decideGatewayRoute(
  snapshot: RoutingSnapshot,
  pathname: string,
  requestedModel: string,
): GatewayRouteDecision {
  const path = parseGatewayAgentPath(pathname);
  if (!path) throw new GatewayRouteError("INVALID_ROUTE");
  // Agent 与协议路径由注册表 binding 声明；未注册的路径一律本地拒绝。
  const binding = agentBindingForPath(path.agent, path.protocolPath);
  if (!binding) throw new GatewayRouteError("PROTOCOL_MISMATCH");
  const parsed = parseGatewayModelId(requestedModel);
  if (!parsed) throw new GatewayRouteError("MODEL_PREFIX_REQUIRED");
  const target = snapshot.targetsById.get(parsed.targetId);
  if (!target) throw new GatewayRouteError("TARGET_NOT_FOUND");

  const protocolUrl = binding.protocol === "openai"
    ? target.openaiUrl
    : target.anthropicUrl;
  if (!protocolUrl) throw new GatewayRouteError("PROTOCOL_MISMATCH");

  if (!target.supportedModels.includes(parsed.modelId)) {
    throw new GatewayRouteError("MODEL_NOT_ALLOWED");
  }
  if (!isModelAllowedForAgent(target, parsed.modelId, path.agent)) {
    throw new GatewayRouteError("MODEL_NOT_ALLOWED");
  }
  if (!isModelWireApiAllowedForAgent(target, parsed.modelId, binding.wireApi)) {
    throw new GatewayRouteError("MODEL_WIRE_API_UNSUPPORTED");
  }
  // 订阅通道（billingChannel=subscription）与显式声明 passthrough 的目标
  // 共用同一条透传门禁：binding 必须声明 supportsSubscription。
  const isPassthrough = target.billingChannel === "subscription"
    || target.gatewayCredentialMode === "passthrough";
  if (isPassthrough && !bindingSupportsSubscription(path.agent, binding.wireApi)) {
    throw new GatewayRouteError("SUBSCRIPTION_PASSTHROUGH_UNSUPPORTED");
  }
  const credentialId = isPassthrough ? undefined : resolveCredentialForAgent(target, path.agent);
  if (!isPassthrough && !credentialId) throw new GatewayRouteError("CREDENTIAL_NOT_CONFIGURED");

  return {
    target,
    modelId: parsed.modelId,
    requestedModel,
    agent: path.agent,
    credentialMode: isPassthrough ? "passthrough" : "inject",
    ...(credentialId ? {credentialId} : {}),
    upstreamPath: path.protocolPath,
    upstreamUrl: protocolUrl,
    wireApi: binding.wireApi,
  };
}
