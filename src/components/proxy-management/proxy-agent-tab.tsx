import {Cable, CheckCircle2, SquareTerminal} from "lucide-react";
import {ConfigFilePreview} from "@/components/proxy-management/config-file-preview";
import {AgentLocalSourceStatus} from "@/components/agent-local-source-status";
import {hasLocalImportAdapter} from "@/lib/agent-local-source/presets";
import {AGENT_CATALOG, agentCompatibleModelsForTarget, claudeAliasModelOptions, targetHasProtocolForAgent, targetSupportsAgent, wireApiCompatibleModelsForTarget} from "@/components/proxy-management/agent-catalog";
import {AGENT_LOGO_EXT} from "@/components/proxy-management/agent-entry-badges";
import type {ConfigFileDisplayManifest} from "@/lib/config-sync/file-display";
import type {CliSyncStatus, CredentialItem} from "./proxy-management-types";
import {agentScopeIncludes, type AgentId, type ProxyConfig, type ProxyTarget} from "@/types";
import styles from "./proxy-management.module.css";

interface ProxyAgentTabProps {
  config: ProxyConfig;
  target: ProxyTarget;
  credentials: CredentialItem[];
  cliStatus?: CliSyncStatus;
  /** 供应商是否已保存：未保存的草稿尚无协议/模型/密钥，不展示 Agent 配置。 */
  targetPersisted: boolean;
  /** 打开「接入 Agent」弹窗（可选预选 Agent）。 */
  onConnectAgent: (agent?: AgentId) => void;
  /** 解除当前供应商与 Agent 的绑定；默认供应商必须先切换。 */
  onUnbindAgent: (agent: AgentId) => void;
  onSetDefault: (agent: AgentId) => Promise<void>;
  onSetModel: (agent: AgentId, modelId: string) => Promise<void>;
  onSetCredential: (agent: AgentId, credentialId: string) => Promise<void>;
  onLaunch: (agent: AgentId) => void;
  /** 更新 Claude Code 全局模型别名（Opus / Sonnet / Haiku），选项来自当前供应商支持该 Agent 的模型。 */
  onUpdateAliases: (agent: "claude", aliases: {opus?: string; sonnet?: string; haiku?: string}) => Promise<void>;
  /**
   * 切换「CLI 形态」（2026-10-09 用户确认）：网关模式（cliSyncEnabled=true，CLI 指向本地
   * 网关）/ 官方模式（cliSyncEnabled=false，清空受管层还原官方登录原生使用）。
   * 仅 codex / claude 展示切换入口（官方登录型 CLI 的 provider 级 either/or）。
   */
  onSetCliForm: (agent: AgentId, gatewayMode: boolean) => Promise<void>;
}

/** 该页签只展示已接入当前代理供应商的 Agent；其余 Agent 通过底部入口接入。 */
export function ProxyAgentTab(props: ProxyAgentTabProps) {
  const {config, target, credentials} = props;
  // 以「当前代理供应商」为视角：卡片只代表真实的 Agent 绑定关系；
  // 即使绑定后暂时缺少协议、模型或密钥，也保留卡片让用户能看到缺口并修复，
  // 未建立绑定的 Agent 只在底部接入入口中出现，避免把未来大量 Agent 铺满页面。
  const supportedByTarget = AGENT_CATALOG.filter(entry => targetSupportsAgent(target, entry.id, credentials));
  const connected = AGENT_CATALOG.filter(entry => {
    const connection = config.agentConnections[entry.id];
    if (!connection || connection.enabled === false) return false;
    return connection.boundTargetIds?.includes(target.id) || connection.defaultTargetId === target.id;
  });
  // 可接入列表按「协议能力支持 ∧ 有 wire 兼容模型 ∧ 尚未完整接入」判定：模型 wire API 兼容
  // 即可接入（不要求已标记适用）——用户主动取消某 Agent 的适用后模型适用被级联清空，
  // 但只要模型本身兼容，该 Agent 仍应出现在「接入其他 Agent」入口，由向导引导重新补齐适用。
  // 与向导可勾选集合（availableAgents ∩ 未完整接入）保持完全一致，避免文案与弹窗矛盾。
  const connectable = AGENT_CATALOG.filter(entry =>
    targetHasProtocolForAgent(target, entry.id)
    && wireApiCompatibleModelsForTarget(target, entry.id).length > 0
    && !connected.includes(entry));
  if (!props.targetPersisted) {
    return <div className={styles.tabStack}><p className={styles.emptyCompact}>请先保存供应商并完成基础配置；保存后会引导接入 Agent，这里将展示当前供应商支持的 Agent 配置。</p></div>;
  }
  return <div className={styles.tabStack}>
    {connected.length === 0 ? <p className={styles.emptyCompact}>当前供应商尚未接入任何 Agent。已准备好协议、兼容模型和密钥后，可在下方「接入其他 Agent」中完成接入。</p> : connected.map(entry => <AgentCard key={entry.id} agent={entry.id} {...props} />)}
    <section className={styles.card}>
      <header className={styles.cardHeader}><div><h3>接入其他 Agent</h3><p>让更多 Agent 使用当前供应商；点击后进入分步引导，自动检测已完成与待补齐的模型、密钥和接入配置。</p></div>{connectable.length > 0 ? <button type="button" className={styles.primaryButton} onClick={() => props.onConnectAgent(connectable[0]?.id)}><Cable size={16} /> 接入其他 Agent</button> : connected.length > 0 ? <span className={`${styles.badge} ${styles.badgeReady}`}>已支持全部可用 Agent</span> : <button type="button" className={styles.secondaryButton} onClick={() => props.onConnectAgent()}><Cable size={16} /> 重新检测并接入 Agent</button>}</header>
      {connectable.length === 0
        ? supportedByTarget.length > 0
          ? <p className={styles.muted}>当前供应商支持的 Agent 均已接入（{supportedByTarget.map(entry => entry.label).join("、")}）；未来新增 Agent 会出现在这里。</p>
          : connected.length > 0
            ? <p className={styles.muted}>当前供应商已有 Agent 接入关系，但仍有协议、模型或密钥待补齐；补齐后可继续使用。</p>
            : <p className={styles.muted}>当前供应商尚无与任何 Agent 协议兼容的模型：请先在「基础配置」确认协议上游 URL（Claude 系模型需要 Anthropic 协议 URL，GPT/o 系列需要 OpenAI 协议 URL），或点击「重新检测并接入 Agent」重探模型——模型协议能力会按当前 URL 重新推断。</p>
        : <p className={styles.muted}>尚未接入的 Agent：{connectable.map(entry => entry.label).join("、")}。</p>}
    </section>
  </div>;
}

function AgentCard({agent, config, target, credentials, cliStatus, onConnectAgent, onUnbindAgent, onSetDefault, onSetModel, onSetCredential, onLaunch, onUpdateAliases, onSetCliForm}: ProxyAgentTabProps & {agent: AgentId}) {
  const entry = AGENT_CATALOG.find(item => item.id === agent);
  const label = entry?.label || agent;
  const available = targetHasProtocolForAgent(target, agent);
  const connection = config.agentConnections[agent];
  const globallyConnected = Boolean(connection && connection.enabled !== false);
  const boundTargetIds = connection?.boundTargetIds || (connection?.defaultTargetId ? [connection.defaultTargetId] : []);
  const connected = globallyConnected && boundTargetIds.includes(target.id);
  const isDefault = connected && connection?.defaultTargetId === target.id;
  // 只提供与该 Agent 协议能力兼容的模型：Codex 只支持 Responses，Chat 模型不出现。
  const models = target ? agentCompatibleModelsForTarget(target, agent) : [];
  const scopeModelCount = target.supportedModels.filter(model => agentScopeIncludes(target.supportedModelScopes?.[model], agent)).length;
  const agentCredentials = credentials.filter(item => item.targetId === target.id && agentScopeIncludes(item.agentScope, agent));
  const defaultModel = target.development?.defaultModels?.[agent] || "";
  const defaultCredential = target.development?.defaultCredentials?.[agent] || "";
  // 配置数据同步状态：来自最近一次 CLI 同步（接入/修改配置时实时触发）。
  const syncWarnings = (cliStatus?.warnings || []).filter(warning => warning.targetId === agent);
  const syncFailed = syncWarnings.length > 0 || Boolean(cliStatus?.errors?.length);
  const otherDefaultTarget = !isDefault && globallyConnected
    ? config.targets.find(item => item.id === connection?.defaultTargetId)
    : undefined;
  const aliases = config.agentConnections.claude?.modelAliases || {};
  // 别名是全局配置：选项只覆盖已接入 Claude Code（绑定）供应商中归属 claude 且
  // wire API 兼容的模型，与保存校验范围一致，避免出现保存不上拉的选项。
  const claudeAliasOptions = claudeAliasModelOptions(config);
  // 该 Agent 的受管文件（同步后完整内容 + 段级高亮）：接口返回宽松结构，此处收敛为展示类型。
  const cliFiles = (cliStatus?.fileDisplays?.[agent] || []) as unknown as ConfigFileDisplayManifest[];

  return <section className={`${styles.card} ${styles.agentConnectionCard}`}>
    <header className={styles.agentCardHeaderV5}>
      <div className={styles.agentCardIdentityV5}>
        <span className={`${styles.agentCardLogoV5} ${agentLogoTone(agent)}`}><img src={`/agent-logos/${agent}.${AGENT_LOGO_EXT[agent] || "png"}`} alt="" /></span>
        <div className={styles.agentCardIdentityCopyV5}>
          <div className={styles.titleWithBadge}>
            <h3>{label}</h3>
            <span className={`${styles.badge} ${connected ? styles.badgeReady : styles.badgePending}`}>{connected ? "已接入" : "待接入"}</span>
            <span className={`${styles.badge} ${available ? styles.badgeReady : styles.badgePending}`}>{available ? "协议可用" : "缺少请求 URL"}</span>
            {isDefault ? <span className={styles.badgeDefault}>当前默认供应商</span> : <span className={styles.badge}>默认供应商：{otherDefaultTarget?.name || connection?.defaultTargetId || "未选择"}</span>}
          </div>
          <p className={styles.agentCardDescriptionV5}>{connected ? "当前供应商已绑定此 Agent。下面的默认访问链与受管文件会随即时设置同步更新。" : `尚未把当前供应商绑定到 ${label}，可通过接入向导补齐模型、密钥与 CLI 配置。`}</p>
        </div>
      </div>
      <div className={styles.inlineActions}>
        {connected && available && !isDefault ? <button type="button" className={styles.secondaryButton} onClick={() => void onSetDefault(agent)}>设为默认供应商</button> : null}
        {connected && !isDefault ? <button type="button" className={styles.secondaryButton} onClick={() => onUnbindAgent(agent)}>解除绑定</button> : null}
        {!connected ? <button type="button" className={styles.primaryButton} onClick={() => onConnectAgent(agent)}><Cable size={16} /> 接入 {label}</button> : null}
        {/* 启动门禁（2026-10-06 与弹窗同口径）：除绑定/协议/默认链外，还要求当前供应商
            至少有一个与该 Agent 协议兼容的模型（agentCompatibleModelsForTarget），
            避免打开一个无法选择任何模型的启动弹窗。 */}
        <button
          type="button"
          className={styles.primaryButton}
          disabled={!connected || !available || models.length === 0 || !defaultModel || (target.billingChannel !== "subscription" && !defaultCredential)}
          title={models.length === 0 ? `当前供应商没有与 ${label} 协议兼容的模型，请先在「基础配置」确认模型与协议上游 URL。` : undefined}
          onClick={() => onLaunch(agent)}
        ><SquareTerminal size={16} /> 在 {label} 中开发</button>
      </div>
    </header>

    {!connected ? <p className={styles.emptyCompact}>尚未接入 {label}：点击「接入 {label}」完成绑定；是否把当前供应商设为默认供应商需在向导中显式选择。</p> : available ? <>
      {agent in CLI_FORM_COPY && connection && !CLI_FORM_COPY[agent as keyof typeof CLI_FORM_COPY].hidden ? <CliFormSection agent={agent as keyof typeof CLI_FORM_COPY} cliSyncEnabled={connection.cliSyncEnabled !== false} onSetCliForm={onSetCliForm} /> : null}
      <section className={styles.agentDefaultsPanelV5}>
        <header className={styles.agentSectionHeaderV5}><div><span className={styles.agentSectionEyebrowV5}>DEFAULT ACCESS CHAIN</span><h4>当前供应商的默认访问链</h4></div><span className={styles.agentSectionStateV5}><CheckCircle2 size={14} /> 修改后立即同步</span></header>
        <div className={styles.formGrid}>
          <label className={styles.field}><span>默认模型</span><select value={defaultModel} onChange={event => void onSetModel(agent, event.currentTarget.value)}><option value="">选择模型</option>{models.map(model => <option key={model} value={model}>{model}</option>)}</select><small>{scopeModelCount > models.length ? `有 ${scopeModelCount - models.length} 个适用模型因协议能力不兼容 ${label} 未列出。` : "默认模型跟随当前供应商；切换默认供应商后需重新设置。"}</small></label>
          {target.billingChannel === "subscription" ? <div className={styles.field}><span>默认密钥</span><p className={styles.muted}>订阅通道无需系统密钥：推理凭据由本机 {label} CLI 登录透传。</p></div> : <label className={styles.field}><span>默认密钥</span><select value={defaultCredential} onChange={event => void onSetCredential(agent, event.currentTarget.value)}><option value="">选择密钥</option>{agentCredentials.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><small>只展示属于当前供应商且适用于 {label} 的密钥。</small></label>}
        </div>
      </section>
      {hasLocalImportAdapter(agent) ? <AgentLocalSourceStatus agentId={agent} /> : null}
      {agent === "claude" ? <div className={styles.aliasGrid}>
        <span className={styles.aliasGridTitle}>Opus / Sonnet / Haiku 全局别名（可选已接入 Claude Code 供应商中兼容的模型）</span>
        {(["opus", "sonnet", "haiku"] as const).map(key => <label key={key} className={styles.field}><span>{key[0]?.toUpperCase()}{key.slice(1)}</span><select value={aliases[key] || ""} onChange={event => void onUpdateAliases("claude", {...aliases, [key]: event.currentTarget.value || undefined})}><option value="">跟随默认模型</option>{claudeAliasOptions.map(model => <option key={model} value={model}>{model}</option>)}</select></label>)}
      </div> : null}
      {syncFailed ? <div className={`${styles.agentSyncState} ${styles.agentSyncFailed}`}><strong>配置数据同步</strong><ul>{syncWarnings.map(warning => <li key={`${warning.targetId}-${warning.code}`}>{warning.message}。{syncFixHint(warning.code)}</li>)}{(cliStatus?.errors || []).map(error => <li key={error}>{error}</li>)}</ul></div> : null}
      {cliFiles.length > 0 ? <div className={styles.agentCliFiles}><div className={styles.agentCliFilesHeader}><div className={styles.agentCliFilesTitleRow}><strong>受管配置文件</strong><span className={styles.agentCliFilesCount}>{cliFiles.length} 个文件</span></div><small>{fileManagementSummary(cliFiles)}</small></div><ConfigFilePreview files={cliFiles} targetId={target.id} /></div> : null}
    </> : <p className={styles.emptyCompact}>当前供应商未配置 {label} 所需协议上游 URL，接入后也无法路由该 Agent 的请求。</p>}
  </section>;
}

/**
 * 「CLI 形态」能力声明表（2026-10-09 用户确认）：仅官方登录型 CLI（codex / claude）
 * 支持 网关 ↔ 官方 切换，文案按 Agent 注册表化（扩展面守卫：禁止 agent 名条件分派）。
 * hidden：2026-10-10 用户确认 claude 暂不支持直连形态，切换区块暂时隐藏（恒网关
 * 模式，文案保留）；后续支持后删除该标记即恢复展示。
 */
const CLI_FORM_COPY: Readonly<Record<"codex" | "claude", {gateway: string; official: string; hidden?: boolean}>> = {
  codex: {
    gateway: "网关模式：CLI 指向本地网关，模型目录为网关模型（中转站 / 按量）；OpenAI 订阅预设模型不可经网关使用（ChatGPT 登录协议差异），需切换官方模式。",
    official: "官方模式：CLI 使用 ChatGPT 登录与官方模型（桌面 App 同样可用），受管网关配置已清空；用量经本机数据直连导入自动捕获。",
  },
  claude: {
    gateway: "网关模式：CLI 指向本地网关；已登录时订阅预设模型透传官方登录，中转站模型走密钥注入。",
    official: "官方模式：CLI 使用官方登录与官方端点，受管网关配置已清空。",
    hidden: true,
  },
};

/** 「CLI 形态」切换区块（2026-10-09 用户确认）：网关 ↔ 官方，仅声明表内的 Agent 展示。 */
function CliFormSection({agent, cliSyncEnabled, onSetCliForm}: {
  agent: "codex" | "claude";
  cliSyncEnabled: boolean;
  onSetCliForm: (agent: AgentId, gatewayMode: boolean) => Promise<void>;
}) {
  const officialMode = !cliSyncEnabled;
  const copy = officialMode ? CLI_FORM_COPY[agent].official : CLI_FORM_COPY[agent].gateway;
  return <section className={styles.agentDefaultsPanelV5}>
    <header className={styles.agentSectionHeaderV5}>
      <div><span className={styles.agentSectionEyebrowV5}>CLI FORM</span><h4>CLI 形态</h4></div>
      <span className={`${styles.badge} ${officialMode ? styles.badgePending : styles.badgeReady}`}>{officialMode ? "官方模式" : "网关模式"}</span>
    </header>
    <p className={styles.muted}>{copy}</p>
    <div className={styles.inlineActions}>
      {officialMode
        ? <button type="button" className={styles.primaryButton} onClick={() => void onSetCliForm(agent, true)}>切换回网关模式</button>
        : <button type="button" className={styles.secondaryButton} onClick={() => void onSetCliForm(agent, false)}>切换到官方模式</button>}
    </div>
    <small className={styles.muted}>切换会立即重写受管配置；已打开的 CLI 客户端重启后生效。</small>
  </section>;
}

/** 配置同步问题的解决方式提示。 */
function syncFixHint(code: string): string {
  const hints: Record<string, string> = {
    AGENT_NOT_CONNECTED: "在弹窗中接入该 Agent 并把默认供应商选为当前供应商即可解决。",
    CLI_SYNC_DISABLED: "该 Agent 处于「官方模式」（CLI 同步关闭）：如需恢复网关模式，请在 Agent 卡片的「CLI 形态」切换。",
    DEFAULT_TARGET_REQUIRED: "为该 Agent 选择默认供应商即可解决。",
    DEFAULT_TARGET_NOT_FOUND: "该 Agent 的默认供应商已被删除，请重新选择。",
    CREDENTIAL_MISSING: "在「密钥与模型」为该供应商新增系统密钥。",
    NO_MODELS: "在「密钥与模型」为该供应商添加支持的模型。",
    MODEL_PRICE_MAPPING_REQUIRED: "在价格中心为该模型补全供应商映射。",
    MODEL_WIRE_API_UNSUPPORTED: "该模型声明的 wire API 与 Agent 可用 binding 无交集，请在模型目录中调整能力。",
    PRESET_WIRE_API_UNSUPPORTED: "当前官方预设的协议接口与该 Agent 的 wire API 不匹配，请更换预设或改用自定义供应商。",
    PROTOCOL_EXCLUDED: "该供应商缺少对应协议的上游 URL，请先在「基础配置」补齐。",
    SUBSCRIPTION_UNSUPPORTED: "该 Agent 首期不支持订阅通道，请改用按量或套餐供应商。",
    DEFAULT_TARGET_NOT_BOUND: "默认供应商未加入该 Agent 的接入范围，请先绑定。",
    CLI_SYNC_TARGET_EXCLUDED: "该供应商已从 Agent 的 CLI 同步中排除，请在接入设置中移除排除。",
  };
  return hints[code] || "";
}

function agentLogoTone(agent: AgentId): string {
  if (agent === "codex") return styles.agentCardLogoCodex;
  if (agent === "claude") return styles.agentCardLogoClaude;
  if (agent === "opencode") return styles.agentCardLogoOpencode;
  if (agent === "zcode") return styles.agentCardLogoZcode;
  return styles.agentCardLogoDsh;
}

/** 受管文件摘要：让不同 Agent 的文件数量与接管方式在卡片标题处直接可见。 */
function fileManagementSummary(files: ConfigFileDisplayManifest[]): string {
  const sensitive = files.filter(file => file.sensitive).length;
  const full = files.filter(file => file.specId === "codex-catalog" || file.specId === "zcode-state").length;
  const partial = Math.max(0, files.length - sensitive - full);
  return [
    partial > 0 ? `局部合并 ${partial}` : "",
    full > 0 ? `整体受管 ${full}` : "",
    sensitive > 0 ? `敏感文件 ${sensitive}` : "",
  ].filter(Boolean).join(" · ");
}
