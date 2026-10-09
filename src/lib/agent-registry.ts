import type {AgentId, ModelsResponseFormat, WireApi, WireProtocol} from "@/types";
import type {AgentKind} from "./conversation-semantics/types";

/**
 * Agent 注册表（网关与 Web 共用、纯函数零依赖）。
 *
 * 这是“Agent Adapter”的单一事实来源：Agent 标识、多协议 binding、网关入口路径、
 * 显示名、语义层 AgentKind 映射（semanticKind）与品牌信息（logo 扩展名）都只在
 * 这里定义。新增 Agent 只需在 types 的 KNOWN_AGENT_IDS 加 id，并在 AGENT_REGISTRY
 * 加注册项；网关白名单、协议分派、页面 Agent 目录、指纹/投影/导出的语义映射自动
 * 生效（semanticKind 消灭了散落各处的同款枚举翻译 switch）。
 */
export interface AgentWireBinding {
  protocol: WireProtocol;
  /** 真实 wire API，不等同于协议族。 */
  wireApi: WireApi;
  /** 网关协议路径段，例如 /v1/chat/completions。 */
  gatewayPath: string;
  /** 该 binding 是否允许订阅透传；首期 OpenCode/dsh 均为 false。 */
  supportsSubscription?: boolean;
}

export interface AgentAdapter {
  id: AgentId;
  label: string;
  /** 语义/指纹层的 AgentKind（如网关 claude → 语义 claude-code）。 */
  semanticKind: AgentKind;
  /** public/agent-logos/<id>.<ext> 的实际文件扩展名。 */
  logoExt: "png" | "ico" | "svg";
  /** 默认 binding，用于 UI 入口。 */
  defaultBinding: AgentWireBinding;
  /** 无显式 wireApi 的 GET /v1/models 诊断请求使用的 binding。 */
  defaultModelsBinding: WireApi;
  bindings: readonly AgentWireBinding[];
  /**
   * 信封探针（2026-09-16）：该 Agent 的请求会把运行时注入内容以可识别的文本信封
   * （system-reminder / 环境上下文等）放进 user 消息——交互内容/预览层据此对
   * user_real 与 user_injected 做精确区分。声明后探针自动启用；未声明 = 该 Agent
   * 无已知信封形态（探针为无害空转）。新增/调整只需改注册表，禁止散落硬编码。
   */
  envelopeProbe?: boolean;
}

export const AGENT_REGISTRY: readonly AgentAdapter[] = [
  {
    id: "codex",
    envelopeProbe: true,
    label: "Codex",
    semanticKind: "codex",
    logoExt: "png",
    // Codex 官方 CLI 只走 Responses API，不注册 chat_completions binding，
    // 避免 chat 模型（如 GLM-5.3）被误判为 Codex 可用。
    defaultBinding: {
      protocol: "openai",
      wireApi: "responses",
      gatewayPath: "/v1/responses",
      supportsSubscription: true,
    },
    defaultModelsBinding: "responses",
    bindings: [
      {
        protocol: "openai",
        wireApi: "responses",
        gatewayPath: "/v1/responses",
        supportsSubscription: true,
      },
    ],
  },
  {
    id: "claude",
    envelopeProbe: true,
    label: "Claude Code",
    semanticKind: "claude-code",
    logoExt: "ico",
    defaultBinding: {
      protocol: "anthropic",
      wireApi: "messages",
      gatewayPath: "/v1/messages",
      supportsSubscription: true,
    },
    defaultModelsBinding: "messages",
    bindings: [
      {
        protocol: "anthropic",
        wireApi: "messages",
        gatewayPath: "/v1/messages",
        supportsSubscription: true,
      },
    ],
  },
  {
    id: "opencode",
    envelopeProbe: true,
    label: "OpenCode",
    semanticKind: "opencode",
    logoExt: "svg",
    defaultBinding: {
      protocol: "openai",
      wireApi: "responses",
      gatewayPath: "/v1/responses",
    },
    defaultModelsBinding: "responses",
    bindings: [
      {
        protocol: "openai",
        wireApi: "responses",
        gatewayPath: "/v1/responses",
      },
      {
        protocol: "openai",
        wireApi: "chat_completions",
        gatewayPath: "/v1/chat/completions",
      },
      {
        protocol: "anthropic",
        wireApi: "messages",
        gatewayPath: "/v1/messages",
      },
    ],
  },
  {
    id: "dsh",
    envelopeProbe: true,
    label: "DeepSeek Harness",
    semanticKind: "dsh",
    logoExt: "ico",
    defaultBinding: {
      protocol: "openai",
      wireApi: "chat_completions",
      gatewayPath: "/v1/chat/completions",
    },
    defaultModelsBinding: "chat_completions",
    // 2026-10-06 官方核实（dsh 0.2.0-rc.2 / pi-ai 0.87.1，dsh-llm-pi-ai README）：
    // provider 层 KnownApi 含 openai-responses 与 anthropic-messages，自定义网关路由
    // 三协议均可声明；默认 binding 保持 chat（DeepSeek 官方主链路），模型按
    // chat > responses > messages 偏好归一分配到对应路由。
    bindings: [
      {
        protocol: "openai",
        wireApi: "chat_completions",
        gatewayPath: "/v1/chat/completions",
      },
      {
        protocol: "openai",
        wireApi: "responses",
        gatewayPath: "/v1/responses",
      },
      {
        protocol: "anthropic",
        wireApi: "messages",
        gatewayPath: "/v1/messages",
      },
    ],
  },
  {
    id: "zcode",
    envelopeProbe: true,
    label: "ZCode",
    semanticKind: "zcode",
    logoExt: "png",
    defaultBinding: {
      protocol: "anthropic",
      wireApi: "messages",
      gatewayPath: "/v1/messages",
      supportsSubscription: true,
    },
    defaultModelsBinding: "messages",
    bindings: [
      {
        protocol: "anthropic",
        wireApi: "messages",
        gatewayPath: "/v1/messages",
        // 登录透传只开放在 messages binding：实际链路是 anthropic kind 的
        // Coding Plan 端点；openai 系透传属未验证场景，保持门禁拒绝。
        supportsSubscription: true,
      },
      {
        protocol: "openai",
        wireApi: "chat_completions",
        gatewayPath: "/v1/chat/completions",
      },
      {
        protocol: "openai",
        wireApi: "responses",
        gatewayPath: "/v1/responses",
      },
    ],
  },
];

export function agentById(id: string): AgentAdapter | undefined {
  return AGENT_REGISTRY.find(item => item.id === id);
}

/** 网关 AgentId → 语义 AgentKind；未注册返回 undefined。 */
export function semanticKindByGatewayId(id: string): AgentKind | undefined {
  return agentById(id)?.semanticKind;
}

/** 全部已注册语义 AgentKind 集合（消灭散落的枚举翻译 switch）。 */
export const KNOWN_SEMANTIC_KINDS: ReadonlySet<string> = new Set(
  AGENT_REGISTRY.map(item => item.semanticKind),
);

/** 语义 AgentKind 是否已注册。 */
export function isKnownSemanticAgentKind(name: string): boolean {
  return KNOWN_SEMANTIC_KINDS.has(name);
}

/** Agent logo 扩展名映射（public/agent-logos/<id>.<ext>）。 */
export const AGENT_LOGO_EXT: Readonly<Record<string, string>> = Object.fromEntries(
  AGENT_REGISTRY.map(item => [item.id, item.logoExt]),
);

/**
 * 网关入口 URL：openai 协议族 = {base}/{agent}/v1，anthropic 协议族 = {base}/{agent}
 * （与代理注入的 CLI base_url 一致；由 defaultBinding 协议推导，新增 Agent 免改 UI）。
 */
export function agentGatewayEntryUrl(agent: string, baseUrl: string): string {
  // 本模块会被代理 bundle 引用，保持字面量兜底、不引入 web 侧模块（全站统一 127.0.0.1）。
  const normalized = baseUrl.replace(/\/+$/, "") || "http://127.0.0.1:3211";
  return agentProtocol(agent) === "anthropic"
    ? `${normalized}/${agent}`
    : `${normalized}/${agent}/v1`;
}

export function agentLabel(id: AgentId | string): string {
  return agentById(id)?.label ?? id;
}

export function isKnownGatewayAgent(id: string): id is AgentId {
  return AGENT_REGISTRY.some(item => item.id === id);
}

/** Agent 的默认协议族；未知 Agent 保守按 anthropic 处理（调用方另行拒绝）。 */
export function agentProtocol(id: AgentId | string): WireProtocol {
  return agentById(id)?.defaultBinding.protocol ?? "anthropic";
}

/** 供应商是否具备某 Agent 默认 binding 所需的协议上游 URL（兼容旧调用）。 */
export function targetHasProtocolForAgent(target: {openaiUrl?: string; anthropicUrl?: string}, agent: AgentId | string): boolean {
  const binding = agentById(agent)?.defaultBinding;
  if (!binding) return false;
  return binding.protocol === "openai" ? Boolean(target.openaiUrl) : Boolean(target.anthropicUrl);
}

/** Agent 的全部 binding。 */
export function agentBindings(agent: AgentId | string): readonly AgentWireBinding[] {
  return agentById(agent)?.bindings ?? [];
}

/** 按网关协议路径解析 binding；未注册返回 undefined。 */
export function agentBindingForPath(
  agent: AgentId | string,
  protocolPath: string,
): AgentWireBinding | undefined {
  return agentBindings(agent).find(binding => binding.gatewayPath === protocolPath);
}

/** Agent 是否注册了指定 wire API。 */
export function agentSupportsWireApi(agent: AgentId | string, wireApi: WireApi): boolean {
  return agentBindings(agent).some(binding => binding.wireApi === wireApi);
}

/** 按 wire API 解析 binding；未注册返回 undefined。 */
export function bindingForWireApi(
  agent: AgentId | string,
  wireApi: WireApi,
): AgentWireBinding | undefined {
  return agentBindings(agent).find(binding => binding.wireApi === wireApi);
}

/** GET /v1/models 输出格式：messages → anthropic，其余 → openai。 */
export function modelsResponseFormatForWireApi(wireApi: WireApi): ModelsResponseFormat {
  return wireApi === "messages" ? "anthropic" : "openai";
}

/** 供应商是否具备某 Agent 任一 binding 所需协议 URL。 */
export function targetHasBindingForAgent(
  target: {openaiUrl?: string; anthropicUrl?: string},
  agent: AgentId | string,
): boolean {
  return agentBindings(agent).some(binding =>
    binding.protocol === "openai"
      ? Boolean(target.openaiUrl)
      : Boolean(target.anthropicUrl),
  );
}

/** 订阅能力永远按 binding 判断，不按 Agent 整体判断。 */
export function bindingSupportsSubscription(
  agent: AgentId | string,
  wireApi: WireApi,
): boolean {
  return bindingForWireApi(agent, wireApi)?.supportsSubscription === true;
}


/** 信封探针能力查询（注册表驱动，禁止散落 agent 名硬编码）。 */
export function isAgentEnvelopeProbeAgent(agentKind: AgentKind | undefined): boolean {
  return AGENT_REGISTRY.some(
    entry => entry.semanticKind === agentKind && entry.envelopeProbe === true,
  );
}