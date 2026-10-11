"use client";

import {
  ChevronDown,
  FolderOpen,
  LoaderCircle,
  SquareTerminal,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { SearchableSelect } from "@/components/searchable-select";
import {agentCompatibleModelsForTarget} from "@/components/proxy-management/agent-catalog";
import { confirmDialog } from "@/components/confirm-dialog";
import type { PricingCatalogPage } from "@/lib/pricing";
import { normalizeResumeSessionId } from "@/lib/development-launch/resume-session";
import {resolveAutoCompactTokenLimit} from "@/lib/development-launch/model-capabilities";
import {buildGatewayModelId} from "@/proxy/gateway-prefix";
import {agentCliIntegration} from "@/lib/agent-cli-integration";
import {agentLabel as registryAgentLabel} from "@/lib/agent-registry";
import {agentGatewayEntryUrl} from "@/lib/agent-registry";
import {agentLaunchDeclarations} from "@/lib/development-launch/strategies/contracts";
import {codexCliFormForTarget, subscriptionLaunchNotice, type CodexCliForm} from "@/lib/subscription-display";
import {resolveGatewayBaseUrl, DSH_WEB_URL} from "@/lib/local-endpoints";
import type { AgentId, AgentLaunchPreferences, ProxyTarget } from "@/types";
import type {
  ConfigSource,
  DevelopmentCli,
  DevelopmentCredentialMetadata,
  DevelopmentModelSelectionContext,
  LaunchConfigurationResolution,
  PlatformCapabilities,
  TerminalCapability,
} from "@/lib/development-launch/types";

interface DevelopmentLaunchDialogProps {
  target: ProxyTarget;
  cli: DevelopmentCli;
  /** 本地网关地址（config.localProxyBaseUrl）；显示与实际注入保持完全一致。 */
  localProxyBaseUrl: string;
  onClose: () => void;
  onOpenPricingCenter: () => void;
  /**
   * 该 Agent 可切换的默认供应商候选（仪表盘场景传入）；缺省时固定使用 target，
   * 供应商管理页从指定供应商打开时保持原有行为。
   */
  targetOptions?: ProxyTarget[];
  /**
   * codex 当前 CLI 形态（true=网关模式同步开启，false=官方模式；undefined = 该
   * Agent 无形态联动，不展示）。父组件切换成功后须更新自身 config 状态回传新值。
   */
  cliSyncEnabled?: boolean;
  /**
   * 切换 CLI 形态（codex「确认切换并启动」流程，2026-10-09 用户确认）：负责
   * agentConnectionPatch 落库 + CLI 受管配置同步；失败抛错由弹窗中止启动。
   */
  onSetCliForm?: (agent: AgentId, gatewayMode: boolean) => Promise<void>;
}

const MODEL_CATALOG_LIMIT = 200;
const MODEL_SEARCH_DEBOUNCE_MS = 200;

/** 按模型 ID 的目录默认值（高级设置预填；官方模型有精确值，模板外模型缺省）。 */
interface ModelCatalogDefaults {
  reasoningLevels: string[];
  defaultReasoningLevel?: string;
  contextWindow?: number;
  autoCompactTokenLimit?: number;
}

/** 高级设置选项集（枚举一律下拉，杜绝自由文本输错）。 */
const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** manualOverrides 中的数值字段（字段种类知识，与 Agent 无关）：按声明表收集后据此做数值校验。 */
const MANUAL_OVERRIDE_NUMBER_KEYS = new Set(["claudeMaxContextTokens", "claudeAutoCompactTokens"]);
const CLAUDE_PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"] as const;
const DSH_REASONING_LEVELS = ["off", "low", "high", "max"] as const;
const DSH_PERMISSION_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;

interface PreflightResponse {
  target: Pick<ProxyTarget, "id" | "name" | "enabled"> & {gatewayBaseUrl: string};
  cli: DevelopmentCli;
  projectDir: string;
  configuration: LaunchConfigurationResolution;
  credentials: DevelopmentCredentialMetadata[];
  executable: { available: boolean; path?: string };
  terminals: TerminalCapability[];
  preferredTerminal?: string;
  warnings: Array<{ code: string; message: string; sourcePath?: string }>;
  modelSelection: DevelopmentModelSelectionContext;
  lastProjectDir?: string;
  modelDefaults?: Record<string, ModelCatalogDefaults>;
  /** 该 Agent 已落库的启动偏好；弹窗预填存量值优先，null 表示无。 */
  launchPreferences?: AgentLaunchPreferences | null;
  nonce: string;
}

interface CapabilitiesResponse extends PlatformCapabilities {
  nonce: string;
}

interface ApiEnvelope {
  nonce?: string;
  error?: string;
  message?: string;
}

export function DevelopmentLaunchDialog({
  target: boundTarget,
  cli,
  localProxyBaseUrl,
  onClose,
  onOpenPricingCenter,
  targetOptions,
  cliSyncEnabled,
  onSetCliForm,
}: DevelopmentLaunchDialogProps) {
  const titleId = useId();
  const resumeSessionInputId = useId();
  const resumeSessionErrorId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const modelRequestSequenceRef = useRef(0);
  const [activeTargetId, setActiveTargetId] = useState(boundTarget.id);
  // 弹窗内可切换默认供应商（候选来自 targetOptions）；切换只影响本次会话，点启动才落库。
  const target = targetOptions?.find(item => item.id === activeTargetId && item.enabled !== false) ?? boundTarget;
  const compatibleModels = agentCompatibleModelsForTarget(target, cli);
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse | null>(null);
  const [nonce, setNonce] = useState("");
  const [projectDir, setProjectDir] = useState("");
  const [preflight, setPreflight] = useState<PreflightResponse | null>(null);
  const [credentialId, setCredentialId] = useState(target.development?.defaultCredentials?.[cli] || "");
  // 默认选中该供应商在当前 Agent 下的显式默认模型；未配置时保持空值并由用户选择。
  const [selectedModel, setSelectedModel] = useState(() => {
    const defaultModel = target.development?.defaultModels?.[cli];
    return defaultModel && compatibleModels.includes(defaultModel) ? defaultModel : "";
  });
  const [modelSource, setModelSource] = useState<ConfigSource>("unset");
  const [modelModified, setModelModified] = useState(false);
  /**
   * 用户在本次弹窗内显式选过模型的闩锁：一旦为 true，预检（选目录 / 切终端 / 重跑）
   * 一律不得再改模型，只有切换默认供应商才复位。用于彻底消除
   * 「选完项目目录后默认模型突然变回之前的」这类回退（2026-09-18 用户确认）。
   */
  const modelUserPickedRef = useRef(false);
  // 高级字段一旦被用户编辑，后续 preflight/目录预填不得静默覆盖。
  const advancedDirtyRef = useRef<Set<string>>(new Set());
  const [modelSearch, setModelSearch] = useState("");
  // Codex 默认「客户端」形态（2026-10-05 用户确认）；dsh 客户端默认在能力加载后设置。
  const [terminal, setTerminal] = useState(
    cli === "codex" ? "codex-client" : target.development?.preferredTerminal || "",
  );
  const [advanced, setAdvanced] = useState<Record<string, string>>({});
  const [resumeSessionId, setResumeSessionId] = useState("");
  const [resumeSessionTouched, setResumeSessionTouched] = useState(false);
  // 启动形态（2026-10-05 统一「启动方式」下拉）：dsh 由终端选择值承载
  // （"dsh-app"=桌面客户端，其余=Web 服务形态的终端）；固定形态 Agent（zcode）
  // 由策略声明；缺省 TUI。不再使用独立 state，避免与终端选择出现两个字段。
  const launchMode: "tui" | "web" | "app" = cli === "dsh"
    ? (terminal === "dsh-app" ? "app" : "web")
    : (agentLaunchDeclarations(cli).fixedLaunchMode
      ?? agentLaunchDeclarations(cli).launchModes[0]
      ?? "tui") as "tui" | "web" | "app";
  const [busyAction, setBusyAction] = useState("");
  /**
   * 启动进度阶段（2026-10-10 C1）：只绑定真实可观测边界——「切换 CLI 形态」
   * 对应 onSetCliForm await 完成，「同步配置并启动」覆盖 /start 请求全程，
   * 响应返回即全部完成（成功消息 + 关窗倒计时）。服务端请求内部（保存默认
   * 链/preSync/拉起/persist）对前端无独立边界，不拆步骤、不做模拟进度。
   */
  const [launchPhase, setLaunchPhase] = useState<"idle" | "switching" | "syncing">("idle");
  /** 本次启动是否包含形态切换（点击时快照）：切换成功后 formMismatch 实时复位，步骤行渲染不能依赖它。 */
  const [launchSwitchedForm, setLaunchSwitchedForm] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const launchLabel = `在 ${registryAgentLabel(cli)} 中开发`;
  // 网关入口由注册表按 defaultBinding 协议推导（与代理注入的 CLI base_url 一致）。
  const gatewayBaseUrl = resolveGatewayBaseUrl(localProxyBaseUrl);
  const strategy = agentLaunchDeclarations(cli);
  const gatewayEntry = agentGatewayEntryUrl(cli, gatewayBaseUrl);
  const cliIntegration = agentCliIntegration(cli);
  const requiresProjectDir = strategy.requiresProjectDir === "required";
  // 高级设置偏好落库到受管配置的 Agent（claude 走进程旗标，不落库）。
  const usesLaunchPreferences = strategy.consumesLaunchPreferences;
  // ———— CLI 形态联动（2026-10-09 用户确认，本期仅 codex，claude 不涉及） ————
  // 弹窗如实展示当前形态；所选供应商要求的形态不符时，启动按钮变为
  // 「确认切换为 X 模式并启动」——点击即确认：先切换（父组件落库并重写受管
  // 配置）再按目标形态启动。OpenAI 订阅预设因 ChatGPT 原生 wire（请求体无
  // model 字段）只能官方直连；其余供应商一律网关模式。联动闸门走策略声明
  // supportsOfficialFormLaunch（当前仅 codex 声明），不写 agent 名条件分派。
  const [gatewayFormMode, setGatewayFormMode] = useState(cliSyncEnabled);
  useEffect(() => {
    setGatewayFormMode(cliSyncEnabled);
  }, [cliSyncEnabled]);
  const cliFormLinked = strategy.supportsOfficialFormLaunch === true
    && gatewayFormMode !== undefined && onSetCliForm !== undefined;
  const requiredForm: CodexCliForm | undefined = cliFormLinked ? codexCliFormForTarget(target) : undefined;
  const requiredGateway = requiredForm !== "official";
  const formMismatch = cliFormLinked && gatewayFormMode !== requiredGateway;
  // 启动实际发生的形态 = 所选供应商要求的形态（不符时按钮先切换再启动）。
  const officialLaunch = cliFormLinked && !requiredGateway;

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeButtonRef.current?.focus();
    void loadCapabilities()
      .then(async loaded => {
        // 桌面客户端优先（2026-10-05 用户确认，声明驱动零分派）：声明了 app 形态、
        // 非 fixedLaunchMode 且检测到客户端已安装时，默认选中客户端（dsh-app）；
        // 未安装保持 Web 缺省。仅在弹窗刚挂载、终端值仍为空/preferredTerminal 时
        // 设置，不覆盖用户后续手动选择。
        const launchDeclaration = agentLaunchDeclarations(cli);
        if (!launchDeclaration.fixedLaunchMode
          && launchDeclaration.launchModes.includes("app")
          && loaded.agents?.[cli]?.appPath
          && (!terminal || terminal === target.development?.preferredTerminal)) {
          setTerminal("dsh-app");
        }
        // 首次预检：E（2026-10-10）直接带上该供应商上次启动目录（target prop 的
        // development.lastProjectDir），免去「空目录预检 → 回填 → 递归第三次预检」
        // 的串行往返；命中时一次请求完成校验并回填显示。codex 挂载时终端恒为
        // codex-client（目录选填、不预填），与递归分支的排除条件一致；prop 缺失
        // lastProjectDir 时仍走 runPreflight 内的递归预填（服务端新鲜值）。
        const initialProjectDir = (requiresProjectDir || cli === "zcode") && cli !== "codex"
          && target.development?.lastProjectDir
          ? target.development.lastProjectDir
          : "";
        const prefilled = await runPreflight(initialProjectDir, loaded.nonce);
        if (!prefilled && initialProjectDir) {
          // 预填目录已失效：回退空目录预检（nonce 已随失败清空，postMutation 会
          // 自动重新获取能力签发新 nonce），保证模型/密钥/终端就位、弹窗可用——
          // 与原递归分支「失败仅清目录」的行为一致。
          setProjectDir("");
          await runPreflight("");
        }
      })
      .catch(cause => {
        setError(errorMessage(cause, "本机开发能力检测失败"));
      });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key === "Tab") trapDialogFocus(event, dialogRef.current);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
    };
    // 弹窗实例固定绑定当前 Agent；供应商切换在弹窗内部通过 activeTargetId 重跑预检。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换默认供应商：清空模型/密钥等目标相关状态并按新目标重跑预检。
  const targetSwitchRanRef = useRef(false);
  useEffect(() => {
    if (!targetSwitchRanRef.current) {
      targetSwitchRanRef.current = true;
      return;
    }
    setPreflight(null);
    setCredentialId(target.development?.defaultCredentials?.[cli] || "");
    // 启动形态与供应商无关（codex-client / dsh-app 是客户端形态值）：切换供应商不得
    // 把「Codex 客户端」重置回终端形态；普通终端选择仍是目标相关状态，清空后由
    // 新目标预检回填 preferredTerminal。
    setTerminal(current => SPECIAL_LAUNCH_TERMINAL_IDS.has(current) ? current : "");
    setSelectedModel("");
    setModelSource("unset");
    setModelModified(false);
    modelUserPickedRef.current = false;
    setAdvanced({});
    advancedDirtyRef.current = new Set();
    // 切换默认供应商：保留用户本次已选目录（工作区路径与目标无关）重跑预检；
    // 输入框为空时由响应 lastProjectDir 按新目标回填（同挂载路径）。
    void runPreflight(projectDir, undefined, true).catch(cause => {
      setError(errorMessage(cause, "默认供应商预检失败"));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTargetId]);

  async function loadCapabilities(): Promise<CapabilitiesResponse> {
    setBusyAction(current => current || "capabilities");
    try {
      const response = await fetch("/api/development-launch/capabilities", { cache: "no-store" });
      const body = await response.json() as CapabilitiesResponse & { message?: string };
      if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
      setCapabilities(body);
      setNonce(body.nonce);
      return body;
    } finally {
      setBusyAction(current => current === "capabilities" ? "" : current);
    }
  }

  async function postMutation<T extends ApiEnvelope>(
    path: string,
    payload: Record<string, unknown>,
    nonceOverride?: string,
    method = "POST",
  ): Promise<T> {
    let activeNonce = nonceOverride || nonce;
    if (!activeNonce) activeNonce = (await loadCapabilities()).nonce;
    const response = await fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, nonce: activeNonce }),
    });
    const body = await response.json() as T;
    if (body.nonce) setNonce(body.nonce);
    if (!response.ok) {
      setNonce("");
      throw new Error(body.message || body.error || `HTTP ${response.status}`);
    }
    return body;
  }

  async function chooseProjectDirectory() {
    setBusyAction("directory");
    setError("");
    setMessage("");
    try {
      const selection = await postMutation<ApiEnvelope & {
        cancelled?: boolean;
        path?: string;
      }>("/api/development-launch/select-directory", {});
      if (selection.cancelled || !selection.path) return;
      // 只更新目录本身：默认模型/密钥/终端/会话 ID 都是用户在本次弹窗里已经做过的选择，
      // 选目录不能把它们重置回已保存的旧默认值（2026-09-18 用户确认）。
      // 历史缺陷：这里曾清空这几个状态并以「强制重置模型」模式重跑预检，
      // 导致「选完项目目录后默认模型突然变回之前的」。
      setProjectDir(selection.path);
      setPreflight(null);
      await runPreflight(selection.path, selection.nonce, false);
    } catch (cause) {
      setError(errorMessage(cause, "项目目录选择失败"));
    } finally {
      setBusyAction("");
    }
  }

  async function runPreflight(
    path = projectDir,
    nonceOverride?: string,
    resetModel = false,
  ): Promise<boolean> {
    setBusyAction("preflight");
    setError("");
    try {
      const body = await postMutation<PreflightResponse>(
        "/api/development-launch/preflight",
        { cli, targetId: target.id, projectDir: path || undefined },
        nonceOverride,
      );
      setPreflight(body);
      // E：携带目录的预检成功即回填显示（目录已通过服务端 realpath/存在性校验）。
      // 不做「服务端 lastProjectDir 与请求值不同则重跑」——该分支会误伤用户
      // 手动选目录/切终端的场景（用户明确选择的新目录理应优先于历史值）。
      if (path) setProjectDir(path);
      // 用户在本次弹窗里显式选过模型后，任何预检（选目录 / 切终端 / 重跑）都不得
      // 静默覆盖；只有显式重置（切换默认供应商）或尚未选择时才采用已保存的默认模型。
      if (resetModel || (!modelModified && !modelUserPickedRef.current)) {
        const configuredPreferred = target.development?.defaultModels?.[cli] || "";
        const preferred = compatibleModels.includes(configuredPreferred) ? configuredPreferred : "";
        setSelectedModel(preferred);
        setModelSource(preferred ? "manual" : "unset");
        setModelModified(false);
        applyModelDefaults(preferred, body.modelDefaults, body.launchPreferences);
      }
      const availableCredentialIds = new Set(body.credentials.map(item => item.id));
      const preferredCredential = target.development?.defaultCredentials?.[cli];
      setCredentialId(current => availableCredentialIds.has(current)
        ? current
        : preferredCredential && availableCredentialIds.has(preferredCredential)
          ? preferredCredential
          : body.credentials[0]?.id || "");
      const availablePreferredTerminal = body.preferredTerminal || target.development?.preferredTerminal;
      setTerminal(current => chooseAvailableTerminal(current || availablePreferredTerminal, body.terminals));
      // 打开弹窗（或切换供应商）且尚未选目录时，用响应里该供应商上次成功启动使用的
      // 目录预填显示（仅 CLI 模式；以服务端响应值为准，见挂载处注释）。
      const prefillTerminal = chooseAvailableTerminal(terminal || availablePreferredTerminal, body.terminals);
      if (!path && !projectDir && (requiresProjectDir || cli === "zcode") && prefillTerminal !== "codex-client" && body.lastProjectDir) {
        setProjectDir(body.lastProjectDir);
        // 递归只能使用上一轮新签发的 nonce，不能复用该轮已消费的操作凭证。
        const prefilled = await runPreflight(body.lastProjectDir, body.nonce, resetModel);
        if (!prefilled) {
          setProjectDir("");
        }
      }
      return true;
    } catch (cause) {
      setError(errorMessage(cause, "配置预检失败"));
      return false;
    } finally {
      setBusyAction("");
    }
  }

  /**
   * 按当前选中模型应用高级设置默认值；用户已编辑字段只在显式切换模型/供应商时重置。
   * 预填顺序（2026-10-06 确认）：已落库启动偏好（按网关复合键取当前模型条目）优先，
   * 缺省才回落目录默认——既让用户看到上次设置的值，也避免「完整状态提交」把存量
   * 自定义值静默替换成目录默认值。存量推理档/权限不在值域内时忽略（视为失效）。
   */
  function applyModelDefaults(
    modelId: string,
    modelDefaults = preflight?.modelDefaults,
    preferences: AgentLaunchPreferences | null | undefined = preflight?.launchPreferences,
  ) {
    const defaults = modelDefaults?.[modelId];
    const storedWindow = modelId
      ? preferences?.contextWindows?.[buildGatewayModelId(target.id, modelId)]
      : undefined;
    const storedAutoCompact = modelId
      ? preferences?.autoCompactTokenLimits?.[buildGatewayModelId(target.id, modelId)]
      : undefined;
    const storedEffort = preferences?.reasoningEffort?.trim() || "";
    const genericEffortDomain = defaults?.reasoningLevels?.length
      ? defaults.reasoningLevels
      : ["low", "high", "max"];
    setAdvanced(current => {
      const next = {...current};
      const effortDefault = defaults?.defaultReasoningLevel || "";
      if ((cli === "codex" || cli === "zcode" || cli === "opencode")
        && !advancedDirtyRef.current.has("modelReasoningEffort")) {
        next.modelReasoningEffort = storedEffort && genericEffortDomain.includes(storedEffort)
          ? storedEffort
          : effortDefault;
      } else if (cli === "claude") {
        // Claude 默认力度固定 xhigh（产品决策）；claude 高级设置走进程旗标，无落库偏好。
        if (!advancedDirtyRef.current.has("effortLevel")) next.effortLevel = "xhigh";
      } else if (cli === "dsh") {
        if (!advancedDirtyRef.current.has("modelReasoningEffort")) {
          next.modelReasoningEffort = storedEffort && (DSH_REASONING_LEVELS as readonly string[]).includes(storedEffort)
            ? storedEffort
            : (DSH_REASONING_LEVELS as readonly string[]).includes(effortDefault)
              ? effortDefault
              : "";
        }
      }
      // 上下文窗口取「已落库偏好 > 目录值」；自动压缩阈值默认为上下文的 95%
      // （目录显式提供阈值时优先，已落库偏好阈值最优先）。
      const contextWindow = storedWindow ?? defaults?.contextWindow;
      const autoCompactDefault = storedAutoCompact
        ?? defaults?.autoCompactTokenLimit
        ?? (contextWindow ? resolveAutoCompactTokenLimit(contextWindow) : undefined);
      if (cli === "codex") {
        if (!advancedDirtyRef.current.has("sandboxMode")) next.sandboxMode = "danger-full-access";
        if (!advancedDirtyRef.current.has("modelContextWindow")) next.modelContextWindow = contextWindow ? String(contextWindow) : "";
        if (!advancedDirtyRef.current.has("modelAutoCompactTokenLimit")) next.modelAutoCompactTokenLimit = autoCompactDefault ? String(autoCompactDefault) : "";
      } else if (cli === "claude") {
        if (!advancedDirtyRef.current.has("claudeMaxContextTokens")) next.claudeMaxContextTokens = contextWindow ? String(contextWindow) : "";
        if (!advancedDirtyRef.current.has("claudeAutoCompactTokens")) next.claudeAutoCompactTokens = autoCompactDefault ? String(autoCompactDefault) : "";
      } else if (cli === "dsh") {
        const storedPermission = preferences?.permissionMode?.trim() || "";
        if (!advancedDirtyRef.current.has("permissionMode")) {
          next.permissionMode = (DSH_PERMISSION_MODES as readonly string[]).includes(storedPermission)
            ? storedPermission
            : "danger-full-access";
        }
        if (!advancedDirtyRef.current.has("modelContextWindow")) next.modelContextWindow = contextWindow ? String(contextWindow) : "";
      } else {
        if (!advancedDirtyRef.current.has("modelContextWindow")) next.modelContextWindow = contextWindow ? String(contextWindow) : "";
      }
      return next;
    });
  }

  function changeSelectedModel(value: string) {
    modelUserPickedRef.current = true;
    setSelectedModel(value);
    const matchesConfigured = configuredModelResolution?.available === true
      && configuredModelResolution.value === value;
    setModelModified(!matchesConfigured);
    setModelSource(matchesConfigured ? configuredModelResolution.source : "manual");
    // 切换模型：新模型重新采用目录/兜底默认；用户可继续编辑。
    advancedDirtyRef.current = new Set();
    applyModelDefaults(value);
  }

  async function startDevelopment() {
    if (
      (!isCodexClientMode && requiresProjectDir && !projectDir)
      || (!credentialFree && !credentialId)
      || (!officialLaunch && !selectedModel)
      || (needsTerminal && !terminal)
      || resumeSessionIdInvalid
    ) {
      if (resumeSessionIdInvalid) setResumeSessionTouched(true);
      return;
    }
    setBusyAction("start");
    setLaunchPhase(formMismatch ? "switching" : "syncing");
    setLaunchSwitchedForm(formMismatch);
    setError("");
    setMessage("");
    // 形态切换回执：switching 记录本次点击是否真的切换了（切换成功后 formMismatch
    // 已复位，成功文案需要这份点击时快照）。
    const switching = formMismatch;
    const switchingGateway = requiredGateway;
    try {
      // 形态不符时按钮即确认（2026-10-09 用户确认）：先切换 CLI 形态（父组件
      // agentConnectionPatch 落库 + 重写受管配置），服务端随后的 start 才能从
      // 配置读到新形态走官方/网关分支；切换失败必须中止启动，不得带旧形态启动。
      if (formMismatch) {
        try {
          await onSetCliForm!(cli, requiredGateway);
          setGatewayFormMode(requiredGateway);
        } catch (cause) {
          setError(errorMessage(cause, "CLI 形态切换失败，已取消本次启动"));
          return;
        }
        setLaunchPhase("syncing");
      }
      const body = await postMutation<ApiEnvelope & {
        defaultNotice?: string;
        dshAlreadyRunning?: boolean;
        zcodeAlreadyRunning?: boolean;
        appliedButRequiresRestart?: boolean;
        preferenceApplyHint?: string;
        appliedSyncWarnings?: Array<{code: string; message: string; targetId?: string}>;
      }>("/api/development-launch/start", {
        cli,
        targetId: target.id,
        projectDir,
        credentialId: credentialFree ? undefined : credentialId,
        // dsh-app 是启动形态值而非 GUI 终端 id，不传给服务端（终端解析自动兜底）。
        terminal: terminal === "dsh-app" ? undefined : terminal,
        // 官方直连形态启动无网关模型概念：不携带模型与偏好（空对象会清除已落库
        // 偏好），服务端按官方模式分支跳过模型/密钥/受管配置链路。
        selectedModel: officialLaunch ? undefined : selectedModel,
        resumeSessionId: normalizedResumeSessionId,
        manualOverrides: buildManualOverrides(),
        // 消费 launchPreferences 的 Agent（codex/zcode/dsh/opencode）以完整状态提交
        // 偏好（空对象 = 清除已落库偏好），随 config-sync 写入受管配置；
        // claude 高级设置走进程旗标，不落库。
        launchPreferences: usesLaunchPreferences && !officialLaunch ? buildLaunchPreferences(target.id) ?? {} : undefined,
        launchMode,
      });
      // ZCode 已在运行：不重复拉起；选了工作区则服务端已发深链打开，否则仅切换焦点。
      // 个人供应商规则层（provider_config.json）约 1 秒热加载：供应商与模型列表
      // 免重启刷新；默认模型选择如未跟随，再引导完全退出重开（常驻提示，用户手动关闭）。
      if (body.zcodeAlreadyRunning) {
        setMessage(projectDir
          ? `检测到 ZCode 已在运行，已请求打开工作区 ${projectDir}。最新的供应商与模型列表会自动加载（约 1 秒）；若默认模型未切换，请完全退出 ZCode（Dock 图标右键 → 退出）后重新打开。`
          : `检测到 ZCode 已在运行，已把焦点切换到 ZCode。最新的供应商与模型列表会自动加载（约 1 秒）；若默认模型未切换，请完全退出 ZCode（Dock 图标右键 → 退出）后重新打开。`);
        return;
      }
      // dsh 已是常驻服务：直接在当前浏览器新标签页打开 Web UI，不再重复启动。
      // dsh 免重启（2026-10-06 用户实测确认：profile/凭据按请求解析）：偏好变化
      // 只提示「下一请求即生效」，正常 700ms 关窗节奏。
      if (body.dshAlreadyRunning) {
        setMessage(`dsh 已在运行，正在打开 ${DSH_WEB_URL}${body.preferenceApplyHint ? `；${body.preferenceApplyHint}` : ""}`);
        window.open(DSH_WEB_URL, "_blank", "noopener");
        window.setTimeout(onClose, 700);
        return;
      }
      const launchAction = isCodexClientMode
        ? `已打开 Codex 客户端`
        : isZcodeApp
          ? `已拉起 ZCode 桌面应用${projectDir ? `并打开工作区 ${projectDir}` : ""}`
          : cli === "dsh"
          ? launchMode === "app"
            ? "已拉起 DeepSeek Harness 桌面客户端"
            : `已在终端启动 ${registryAgentLabel(cli)} Web 服务，浏览器将打开 ${DSH_WEB_URL}`
          : normalizedResumeSessionId
            ? `已在终端发起恢复 ${registryAgentLabel(cli)} 会话`
            : `已在终端启动 ${registryAgentLabel(cli)}`;
      // 启动前同步警告（白名单后的用户向回退提示）如实附在文案里；Codex 客户端模式的
      // 条件式重启提示由服务端 preferenceApplyHint 提供。启动成功后统一自动关窗
      // （2026-10-08 用户确认，取代 2026-10-06「需要重启类提示常驻不关窗」口径）：
      // Codex 客户端带重启提示时延长到 1.5s 让长文案来得及读，其余路径维持 700ms。
      // zcode 运行中常驻提示仍在上方 alreadyRunning 分支（既有确认口径，不受影响）。
      const warningNotes = (body.appliedSyncWarnings ?? []).map(warning => warning.message).join("；");
      // 本次点击发生了形态切换：重写受管配置后，已打开的 Codex 客户端必须完全退出
      // 重开才能读到新配置（用户实测确认）；终端形态的新进程天然读新配置。
      const formSwitchNote = switching
        ? `已切换为${switchingGateway ? "网关" : "官方"}模式并重写受管配置；已在运行的 Codex 客户端请完全退出后重开生效`
        : "";
      const closeDelayMs = (body.preferenceApplyHint && isCodexClientMode) || formSwitchNote ? 1500 : 700;
      setMessage(launchAction
        + (formSwitchNote ? `；${formSwitchNote}` : "")
        + (body.preferenceApplyHint ? `；${body.preferenceApplyHint}` : "")
        + (warningNotes ? `；注意：${warningNotes}` : "")
        + (body.defaultNotice ? `；${body.defaultNotice}` : ""));
      window.setTimeout(onClose, closeDelayMs);
    } catch (cause) {
      setError(errorMessage(cause, "启动失败"));
    } finally {
      setBusyAction("");
      setLaunchPhase("idle");
    }
  }

  /**
   * CLI 参数类覆盖（manualOverrides）：按声明表（manualOverrideKeys）只收集该
   * Agent 策略真正以进程旗标消费的键。codex 的上下文窗口/压缩阈值/推理档对
   * 目录内网关模型走 launchPreferences → 目录条目（2026-10-02 修复：-c/config.toml
   * 顶层键被条目级能力位覆盖，实测无效）；zcode/dsh/opencode 同样只走偏好。
   */
  function buildManualOverrides(): Record<string, string | number> | undefined {
    const result: Record<string, string | number> = {};
    for (const key of strategy.manualOverrideKeys) {
      const raw = advanced[key]?.trim();
      if (!raw) continue;
      if (MANUAL_OVERRIDE_NUMBER_KEYS.has(key)) {
        const parsed = Number(raw);
        if (Number.isSafeInteger(parsed) && parsed > 0) result[key] = parsed;
      } else {
        result[key] = raw;
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  /** 受管配置类偏好（launchPreferences）：按声明表（launchPreferenceFields）收集；
   * 键为网关模型 ID（<模型ID>_<目标路由ID>），同一模型跨目标（中转站简配 vs
   * 官方大窗）可各自覆盖（2026-10-02 用户确认统一规范）。 */
  function buildLaunchPreferences(targetId: string): AgentLaunchPreferences | undefined {
    if (!usesLaunchPreferences || !selectedModel) return undefined;
    const preferences: AgentLaunchPreferences = {};
    const gatewayModelId = buildGatewayModelId(targetId, selectedModel);
    for (const field of strategy.launchPreferenceFields) {
      const raw = advanced[field]?.trim();
      if (!raw) continue;
      switch (field) {
        case "modelReasoningEffort":
          preferences.reasoningEffort = raw;
          break;
        case "permissionMode":
          preferences.permissionMode = raw;
          break;
        case "modelContextWindow": {
          const contextWindow = Number(raw);
          if (Number.isSafeInteger(contextWindow) && contextWindow > 0) {
            preferences.contextWindows = {[gatewayModelId]: contextWindow};
          }
          break;
        }
        case "modelAutoCompactTokenLimit": {
          const autoCompact = Number(raw);
          if (Number.isSafeInteger(autoCompact) && autoCompact > 0) {
            preferences.autoCompactTokenLimits = {[gatewayModelId]: autoCompact};
          }
          break;
        }
        default:
          break;
      }
    }
    return Object.keys(preferences).length > 0 ? preferences : undefined;
  }

  function updateAdvanced(key: string, value: string) {
    advancedDirtyRef.current.add(key);
    setAdvanced(current => ({ ...current, [key]: value }));
  }

  const cliCapability = capabilities?.agents?.[cli];
  const configuredModelResolution = preflight?.modelSelection.configuredModel;
  const modelRequired = Boolean(preflight && !selectedModel);
  const modelOptions = compatibleModels.map(modelId => ({
    value: modelId,
    label: modelId,
  }));
  const isCodexClientMode = strategy.clientTerminalId !== undefined
    && terminal === strategy.clientTerminalId;
  const needsTerminal = strategy.terminalPolicy === "standard" && launchMode !== "app";
  // ZCode 是桌面 App 形态：无终端要求；项目目录为选填工作区（zcode:// 深链打开）。
  const isZcodeApp = cli === "zcode";
  const subscription = target.billingChannel === "subscription";
  const passthrough = target.credentialMode === "passthrough";
  /** 订阅通道、登录透传与官方直连形态启动都不需要系统密钥。 */
  const credentialFree = subscription || passthrough || officialLaunch;
  const resumeSessionIdInvalid = (() => {
    try {
      normalizeResumeSessionId(resumeSessionId, cli);
      return false;
    } catch {
      return true;
    }
  })();
  const normalizedResumeSessionId = resumeSessionIdInvalid
    ? undefined
    : normalizeResumeSessionId(resumeSessionId, cli);
  // dsh 固定 Web UI 形态（http://127.0.0.1:3080），不再支持一次性任务。
  const dshLaunchChannel = cli === "dsh" ? capabilities?.agents?.dsh?.launchChannel : undefined;
  // 桌面客户端（DeepSeek Harness）安装位置：capabilities 探测（/Applications 或
  // %LOCALAPPDATA%），未安装时客户端选项禁用并保持 Web 缺省（通用索引，零分派）。
  const dshDesktopAppInstalled = capabilities?.agents?.[cli]?.appPath;
  const modelDefaults = selectedModel ? preflight?.modelDefaults?.[selectedModel] : undefined;
  /** 推理强度下拉选项：目录档位优先，缺失时按 Agent 值域兜底。 */
  const reasoningOptions = (() => {
    if (cli === "dsh") return [...DSH_REASONING_LEVELS];
    if (cli === "claude") return [...CLAUDE_EFFORT_LEVELS];
    const levels = modelDefaults?.reasoningLevels || [];
    return levels.length > 0 ? levels : ["low", "high", "max"];
  })();
  /** 启动按钮置灰原因：按 launchDisabled 条件顺序给出首个未满足项，避免用户猜测。 */
  function launchDisabledReason(): string | null {
    // 能力/预检未就绪前不显示任何阻断原因，避免打开瞬间闪现误导性红色提示。
    if (!capabilities) return null;
    if (!capabilities?.supported) return "当前版本仅支持 macOS 和 Windows。";
    if (!cliCapability?.available) return isZcodeApp
      ? `未检测到 ZCode 桌面应用（请确认 /Applications/ZCode.app 已安装）。`
      : `未检测到 ${registryAgentLabel(cli)} 服务（需要全局 CLI 或可用的 npx 缓存）。`;
    if (!capabilities?.credentialStoreAvailable && !credentialFree) return "系统凭据库不可用，无法安全读取开发密钥。";
    if (!isCodexClientMode && requiresProjectDir && !projectDir) return "请先选择项目目录。";
    if (!preflight) return "配置预检尚未完成，请稍候。";
    if (!credentialFree && !credentialId) return "该供应商还没有可用密钥，请先新增系统密钥。";
    if (!officialLaunch && !selectedModel) return "请选择模型。";
    if (needsTerminal && !terminal) return "请选择启动方式。";
    if (resumeSessionIdInvalid) return resumeErrorText();
    return null;
  }
  const launchDisabled = busyAction !== ""
    || !capabilities?.supported
    || !cliCapability?.available
    || (!credentialFree && !capabilities?.credentialStoreAvailable)
    || (!isCodexClientMode && requiresProjectDir && !projectDir)
    || !preflight
    || (!credentialFree && !credentialId)
    || (!officialLaunch && !selectedModel)
    || (needsTerminal && !terminal)
    || resumeSessionIdInvalid;
  const launchBlockReason = launchDisabled ? launchDisabledReason() : null;
  /** 形态不符时按钮即确认（2026-10-09 用户确认）：切换到目标形态并继续启动。 */
  const launchButtonLabel = formMismatch
    ? `确认切换为${requiredGateway ? "网关" : "官方"}模式并启动 ${registryAgentLabel(cli)}`
    : `打开 ${registryAgentLabel(cli)}`;

  return (
    <div className="development-launch-backdrop" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        ref={dialogRef}
        className="development-launch-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className={`development-launch-header agent-theme-${cli}`}>
          <div>
            <h2 id={titleId}>{launchLabel}</h2>
            <p>{officialLaunch
              ? "官方直连模式下仅记录默认供应商与目录偏好，不注入网关配置；模型在 Codex 客户端内选择。"
              : "启动成功后，本代理与所选模型会设为该 Agent 的默认并同步本地配置；Codex 客户端模式会先写入高级设置再打开客户端。"}</p>
          </div>
          <button ref={closeButtonRef} type="button" className="icon-button" onClick={onClose} aria-label="关闭开发启动弹窗">
            <X size={16} />
          </button>
        </header>

        <div className="development-launch-body">
          <dl className={`development-target-summary${cliFormLinked ? " with-cli-form" : ""}`}>
            <div><dt>供应商</dt><dd>{target.name}</dd></div>
            <div><dt>协议</dt><dd>{protocolLabel(cli)}</dd></div>
            {cliFormLinked ? (
              <div>
                <dt>CLI 形态</dt>
                <dd>
                  <span className={`development-cli-form-badge ${gatewayFormMode ? "is-gateway" : "is-official"}`}>
                    {gatewayFormMode ? "网关模式" : "官方模式"}
                  </span>
                  {formMismatch ? <small className="development-cli-form-hint">启动时将切换为{requiredGateway ? "网关" : "官方"}模式</small> : null}
                </dd>
              </div>
            ) : null}
            <div><dt>网关地址</dt><dd>{gatewayEntry}</dd></div>
          </dl>

          {!capabilities?.supported && capabilities ? (
            <div className="development-notice error" role="alert">当前版本仅支持 macOS 和 Windows。</div>
          ) : cliCapability && !cliCapability.available ? (
            <div className="development-notice error" role="alert">
              未检测到 {registryAgentLabel(cli)} CLI，请先安装并确认命令已加入 PATH。
            </div>
          ) : capabilities && !capabilities.credentialStoreAvailable ? (
            <div className="development-notice error" role="alert">系统凭据库不可用，无法安全读取开发密钥。</div>
          ) : capabilities && needsTerminal && !capabilities.terminals.some(item => item.available) ? (
            <div className="development-notice error" role="alert">未检测到可用终端。</div>
          ) : officialLaunch ? (
            // 官方直连模式说明（取代 codex 订阅目标的旧死路提示：弹窗已能一键切换，
            // 不再把用户支去 Agent 接入页）。claude 订阅提示保持原样（本期不涉及）。
            <div className="development-notice development-notice-info" role="status">
              官方直连模式：Codex 使用 ChatGPT 官方登录与官方模型，请求不经本网关（OpenAI 登录协议限制，订阅模型无法经网关路由）；用量由本机数据自动导入观测与账本，无需任何手动操作。
            </div>
          ) : passthrough ? (
            <div className="development-notice" role="status">登录透传目标：网关不注入凭据，转发 {registryAgentLabel(cli)} 自带登录态，套餐额度照常扣减；同步后需重启该客户端生效。</div>
          ) : subscription && !cliFormLinked ? (
            <div className="development-notice" role="status">{subscriptionLaunchNotice(cli)}</div>
          ) : null}

          <div className="development-required-fields">
            {targetOptions && targetOptions.filter(item => item.enabled !== false).length > 0 ? (
            <div className="development-field">
              <label>默认供应商 <span className="required-mark">*</span></label>
              <div className="development-inline-field">
                <select
                  value={activeTargetId}
                  onChange={event => setActiveTargetId(event.currentTarget.value)}
                  disabled={Boolean(busyAction)}
                  aria-label="选择该 Agent 的默认供应商"
                >
                  {targetOptions.filter(item => item.enabled !== false).map(item => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </div>
            </div>
            ) : null}
            {officialLaunch ? (
              <div className="development-field">
                <label>默认模型</label>
                <p className="development-official-form-note">
                  官方直连模式下模型在 Codex 客户端内选择（ChatGPT 官方登录），无需在此选择。
                </p>
              </div>
            ) : (
            <div className="development-field">
              <label>默认模型 <span className="required-mark">*</span></label>
              <div className="development-inline-field">
                <SearchableSelect
                  value={selectedModel}
                  options={modelOptions}
                  searchValue={modelSearch}
                  onSearchChange={setModelSearch}
                  onChange={value => value && changeSelectedModel(value)}
                  placeholder="请选择模型"
                  searchPlaceholder="搜索模型"
                  disabled={!preflight || modelOptions.length === 0}
                  ariaLabel="选择该供应商支持的模型"
                />
              </div>
              {!selectedModel ? (
                <small className={modelRequired ? "field-error" : ""}>
                  {modelOptions.length === 0
                    ? "当前供应商尚未配置支持的模型，请先返回供应商管理配置。"
                    : "请选择该供应商支持的模型。"}
                </small>
              ) : null}
            </div>
            )}

            {!credentialFree ? (
            <div className="development-field">
              <label>默认密钥 <span className="required-mark">*</span></label>
              <div className="development-inline-field">
                <select
                  value={credentialId}
                  onChange={event => setCredentialId(event.currentTarget.value)}
                  disabled={!preflight || (preflight?.credentials.length ?? 0) === 0}
                  aria-label="选择该供应商的默认密钥"
                >
                  {(preflight?.credentials ?? []).map(item => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
              </div>
              {preflight && (preflight.credentials.length ?? 0) === 0 ? (
                <small className="field-error">该供应商还没有可用密钥，请先新增系统密钥。</small>
              ) : null}
            </div>
            ) : null}

            {!isZcodeApp ? (
            <div className="development-field">
              <label>启动方式 <span className="required-mark">*</span></label>
              <div className="development-inline-field">
                <select
                  value={terminal}
                  onChange={event => {
                    const value = event.currentTarget.value;
                    setTerminal(value);
                    // 切回 CLI 形态且尚未选目录时，用该供应商上次使用的目录预填。
                    if (value !== "codex-client" && value !== "dsh-app"
                      && !projectDir && preflight?.lastProjectDir) {
                      setProjectDir(preflight.lastProjectDir);
                      void runPreflight(preflight.lastProjectDir);
                    }
                  }}
                  disabled={!capabilities}
                  aria-label="选择启动方式"
                >
                  {cli === "codex" ? (
                    <option value="codex-client">Codex 客户端</option>
                  ) : null}
                  {cli === "dsh" ? (
                    <option value="dsh-app" disabled={!dshDesktopAppInstalled}>
                      DeepSeek Harness 客户端{dshDesktopAppInstalled ? "" : "（未安装）"}
                    </option>
                  ) : null}
                  {(preflight?.terminals || capabilities?.terminals || []).filter(item => item.available).map(item => (
                    <option key={item.id} value={item.id}>
                      {/* 提供 Web 服务形态的 Agent（当前仅 dsh）：终端选项实际承载 Web 启动，
                          标注后缀避免与「客户端」形态混淆（2026-10-05 用户确认）。 */}
                      {strategy.launchModes.includes("web") ? `${item.label} · 触发 Web 启动` : item.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            ) : null}

            {requiresProjectDir ? (
              <div className="development-field">
                <label htmlFor="development-project-dir">项目目录{isCodexClientMode ? "（选填）" : ""} {!isCodexClientMode ? <span className="required-mark">*</span> : null}</label>
                <div className="development-inline-field">
                  <input id="development-project-dir" value={projectDir} readOnly placeholder={isCodexClientMode ? "留空则打开 Codex 客户端默认工作区" : "请选择本地项目目录"} />
                  <button type="button" className="secondary-button" onClick={chooseProjectDirectory} disabled={Boolean(busyAction)}>
                    <FolderOpen size={15} />
                    <span>选择目录</span>
                  </button>
                </div>
              </div>
            ) : null}

            {isZcodeApp ? (
              <div className="development-field">
                <label htmlFor="development-project-dir">工作区目录（选填）</label>
                <div className="development-inline-field">
                  <input id="development-project-dir" value={projectDir} readOnly placeholder="留空则打开 ZCode 默认界面" />
                  <button type="button" className="secondary-button" onClick={chooseProjectDirectory} disabled={Boolean(busyAction)}>
                    <FolderOpen size={15} />
                    <span>选择目录</span>
                  </button>
                </div>
              </div>
            ) : null}

          </div>

          {preflight?.warnings.length ? (
            <div className="development-warning-list">
              {preflight.warnings.map((warning, index) => (
                <p key={`${warning.code}-${index}`}>
                  <span>{warning.message}</span>
                  {warning.sourcePath ? <code>{warning.sourcePath}</code> : null}
                </p>
              ))}
            </div>
          ) : null}

          <details className="development-advanced" open={cli === "dsh" || cli === "zcode"}>
            <summary><ChevronDown size={15} />高级设置</summary>
            <div className="development-advanced-grid">
              {cliIntegration.resume ? (
                <div className="development-field development-session-id">
                  <label htmlFor={resumeSessionInputId}>原生会话 Session ID</label>
                  <input
                    id={resumeSessionInputId}
                    value={resumeSessionId}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={cli === "opencode"
                      ? "留空则新建会话；粘贴 ses_ 开头的 Session ID 可继续"
                      : cli === "codex"
                        ? "留空则新建会话；粘贴 Session ID（UUID）或会话名称可继续"
                        : "留空则新建会话；粘贴 Session ID 可继续已有会话"}
                    aria-invalid={resumeSessionTouched && resumeSessionIdInvalid}
                    aria-describedby={resumeSessionTouched && resumeSessionIdInvalid
                      ? resumeSessionErrorId
                      : undefined}
                    onChange={event => setResumeSessionId(event.currentTarget.value)}
                    onBlur={() => setResumeSessionTouched(true)}
                  />
                  {resumeSessionTouched && resumeSessionIdInvalid ? (
                    <small id={resumeSessionErrorId} className="field-error" role="alert">
                      {resumeErrorText()}
                    </small>
                  ) : null}
                </div>
              ) : null}
              {cli === "codex" ? (
                <>
                  {/* 官方直连模式下推理档/上下文/压缩阈值只写网关模型目录条目，无意义故隐藏；沙箱是 Codex 原生顶层键仍可用。 */}
                  {!officialLaunch ? (
                    <DevelopmentSelect
                      label="推理强度"
                      value={advanced.modelReasoningEffort || ""}
                      options={reasoningOptions}
                      onChange={value => updateAdvanced("modelReasoningEffort", value)}
                      placeholder={reasoningOptions.length > 0 ? undefined : "目录未提供档位"}
                    />
                  ) : null}
                  <DevelopmentSelect
                    label="沙箱模式"
                    value={advanced.sandboxMode || ""}
                    options={[...CODEX_SANDBOX_MODES]}
                    onChange={value => updateAdvanced("sandboxMode", value)}
                  />
                  {!officialLaunch ? (
                    <>
                      <DevelopmentInput label="上下文上限" type="number" value={advanced.modelContextWindow || ""} onChange={value => updateAdvanced("modelContextWindow", value)} placeholder={modelDefaults?.contextWindow ? undefined : "目录未提供"} />
                      <DevelopmentInput label="自动压缩阈值" type="number" value={advanced.modelAutoCompactTokenLimit || ""} onChange={value => updateAdvanced("modelAutoCompactTokenLimit", value)} placeholder="留空取上下文×95%" />
                    </>
                  ) : null}
                </>
              ) : cli === "claude" ? (
                <>
                  <DevelopmentSelect
                    label="Effort"
                    value={advanced.effortLevel || ""}
                    options={[...CLAUDE_EFFORT_LEVELS]}
                    onChange={value => updateAdvanced("effortLevel", value)}
                    placeholder={resolvedField(preflight, "effortLevel")}
                  />
                  <DevelopmentSelect
                    label="权限模式"
                    value={advanced.permissionMode || ""}
                    options={[...CLAUDE_PERMISSION_MODES]}
                    onChange={value => updateAdvanced("permissionMode", value)}
                    placeholder={resolvedField(preflight, "permissionMode")}
                  />
                  <DevelopmentInput label="上下文上限" type="number" value={advanced.claudeMaxContextTokens || ""} onChange={value => updateAdvanced("claudeMaxContextTokens", value)} placeholder={resolvedField(preflight, "claudeMaxContextTokens")} />
                  <DevelopmentInput label="自动压缩阈值" type="number" value={advanced.claudeAutoCompactTokens || ""} onChange={value => updateAdvanced("claudeAutoCompactTokens", value)} placeholder="auto（留空跟随默认）" />
                </>
              ) : cli === "zcode" ? (
                <>
                  <DevelopmentSelect
                    label="默认推理强度"
                    value={advanced.modelReasoningEffort || ""}
                    options={reasoningOptions}
                    onChange={value => updateAdvanced("modelReasoningEffort", value)}
                    placeholder={reasoningOptions.length > 0 ? undefined : "目录未提供档位"}
                  />
                  <DevelopmentInput
                    label="上下文上限"
                    type="number"
                    value={advanced.modelContextWindow || ""}
                    onChange={value => updateAdvanced("modelContextWindow", value)}
                    placeholder={modelDefaults?.contextWindow ? undefined : "目录未提供"}
                  />
                </>
              ) : cli === "dsh" ? (
                <>
                  <DevelopmentSelect
                    label="默认推理强度"
                    value={advanced.modelReasoningEffort || ""}
                    options={[...DSH_REASONING_LEVELS]}
                    onChange={value => updateAdvanced("modelReasoningEffort", value)}
                  />
                  <DevelopmentSelect
                    label="权限模式"
                    value={advanced.permissionMode || ""}
                    options={[...DSH_PERMISSION_MODES]}
                    onChange={value => updateAdvanced("permissionMode", value)}
                  />
                  <DevelopmentInput
                    label="上下文上限"
                    type="number"
                    value={advanced.modelContextWindow || ""}
                    onChange={value => updateAdvanced("modelContextWindow", value)}
                    placeholder={modelDefaults?.contextWindow ? undefined : "目录未提供"}
                  />
                </>
              ) : cli === "opencode" ? (
                <>
                  <DevelopmentSelect
                    label="默认推理强度"
                    value={advanced.modelReasoningEffort || ""}
                    options={reasoningOptions}
                    onChange={value => updateAdvanced("modelReasoningEffort", value)}
                    placeholder={reasoningOptions.length > 0 ? undefined : "目录未提供档位"}
                  />
                  <DevelopmentInput
                    label="上下文上限"
                    type="number"
                    value={advanced.modelContextWindow || ""}
                    onChange={value => updateAdvanced("modelContextWindow", value)}
                    placeholder={modelDefaults?.contextWindow ? undefined : "目录未提供"}
                  />
                </>
              ) : null}
            </div>
          </details>

          <div className="development-status" aria-live="polite">
            {error ? <p className="error" role="alert">{error}</p> : message ? <p className="success">{message}</p> : null}
          </div>

          {busyAction === "start" ? (
            <ol className="development-launch-stepper" role="status" aria-label="启动进度">
              {launchSwitchedForm ? (
                <li className={launchPhase === "switching" ? "active" : "done"}>
                  <span>切换 CLI 形态</span>
                </li>
              ) : null}
              <li className={launchPhase === "syncing" ? "active" : "pending"}>
                <span>同步配置并启动 {registryAgentLabel(cli)}</span>
              </li>
            </ol>
          ) : null}
        </div>

        <footer className={`development-launch-actions agent-theme-${cli}`}>
          {isCodexClientMode || launchBlockReason ? (
            <div className="development-launch-footer-notes">
              {/* Codex 客户端是单实例：`codex app` 只会激活旧实例，网关/官方形态
                  切换（受管配置 + 占位 auth）与配置变化对运行中的客户端不生效，
                  必须完全退出重开；终端形态每次启动都是新进程、天然读新配置，
                  不在此列（2026-10-11 用户确认常驻文案，客户端形态左下角稳定展示）。 */}
              {isCodexClientMode ? (
                <p className="development-launch-client-restart-note" role="status">
                  切换网关直连及配置变化，运行中的 Codex 需完全退出后重开生效
                </p>
              ) : null}
              {launchBlockReason ? <p className="development-launch-blocked-reason" role="status">{launchBlockReason}</p> : null}
            </div>
          ) : null}
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="button" className="primary-button" onClick={startDevelopment} disabled={launchDisabled} title={formMismatch ? "将先把 Codex 切换为目标形态（重写受管配置），再启动；已打开的 Codex 客户端需完全退出后重开生效。" : undefined}>
            {busyAction === "start" ? <LoaderCircle className="spin" size={16} /> : <SquareTerminal size={16} />}
            <span>{launchButtonLabel}</span>
          </button>
        </footer>
      </section>
    </div>
  );
}

function DevelopmentInput(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  hint?: string;
  type?: "text" | "number";
}) {
  return (
    <label>
      <span>{props.label}</span>
      <input
        type={props.type || "text"}
        min={props.type === "number" ? 1 : undefined}
        value={props.value}
        placeholder={props.placeholder || "继承配置"}
        onChange={event => props.onChange(event.currentTarget.value)}
        onBlur={props.onBlur}
      />
      {props.hint ? <small>{props.hint}</small> : null}
    </label>
  );
}

/** 枚举下拉：第一项为空值（继承配置 / 不设置），杜绝自由文本输错。 */
function DevelopmentSelect(props: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label>
      <span>{props.label}</span>
      <select value={props.value} onChange={event => props.onChange(event.currentTarget.value)}>
        <option value="">{props.placeholder || "继承配置"}</option>
        {props.options.map(option => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
      {props.hint ? <small>{props.hint}</small> : null}
    </label>
  );
}

function resumeErrorText(): string {
  return "请输入规范 UUID、Codex 会话名称，或留空以新建会话。";
}

function trapDialogFocus(event: KeyboardEvent, dialog: HTMLElement | null): void {
  if (!dialog) return;
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>([
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "summary",
    "[href]",
    '[tabindex]:not([tabindex="-1"])',
  ].join(","))).filter(element => element.offsetParent !== null);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function protocolLabel(cli: DevelopmentCli): string {
  if (cli === "codex") return "OpenAI / Responses";
  if (cli === "claude") return "Anthropic / Messages";
  if (cli === "opencode") return "OpenAI Responses / Chat Completions / Anthropic Messages";
  // ZCode 官方三协议（2026-10-06 App 包内 schema 实证）：受管条目按协议分三路由。
  if (cli === "zcode") return "Anthropic Messages / OpenAI Responses / Chat Completions";
  // dsh 三协议（2026-10-06 官方核实 pi-ai KnownApi）。
  return "OpenAI Chat Completions / Responses / Anthropic Messages";
}

/** 非 GUI 终端的特殊形态值（codex-client=Codex 客户端；dsh-app=dsh 桌面客户端）：preflight 重跑不得重置。 */
const SPECIAL_LAUNCH_TERMINAL_IDS = new Set(["codex-client", "dsh-app"]);

function chooseAvailableTerminal(preferred: string | undefined, terminals: TerminalCapability[]): string {
  if (preferred && SPECIAL_LAUNCH_TERMINAL_IDS.has(preferred)) return preferred;
  if (preferred && terminals.some(item => item.id === preferred && item.available)) return preferred;
  return terminals.find(item => item.available)?.id || "";
}

function sourceLabel(source: ConfigSource): string {
  const labels: Record<ConfigSource, string> = {
    project_local: "项目本地配置",
    project: "项目配置",
    profile: "Profile 配置",
    user: "全局配置",
    manual: "本次手动设置",
    unset: "未设置",
  };
  return labels[source];
}

function resolvedField(preflight: PreflightResponse | null, key: keyof LaunchConfigurationResolution["fields"]): string {
  const field = preflight?.configuration.fields[key];
  return field?.value === undefined ? "继承配置" : `${field.value} · ${sourceLabel(field.source)}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
