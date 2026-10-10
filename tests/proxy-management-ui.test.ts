import {existsSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {describe, expect, test} from "vitest";

const componentDir = "src/components/proxy-management";

describe("代理管理 V3 页面结构", () => {
  test("供应商目录确认面板：存量目标有差异时展示，新建预设模型收进自定义设置", async () => {
    const review = await readFile(`${componentDir}/provider-catalog-review.tsx`, "utf8");
    const basic = await readFile(`${componentDir}/proxy-basic-tab.tsx`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    // 存量刷新 = 与「探测上游模型」同构的只加不减表格（2026-10-07 用户确认）：
    // 价格/能力由目录小时同步自动更新（价格中心唯一数据源，无「更新确认」一说）；
    // 已加入模型强制勾选不可取消（移除统一走模型列表行删除按钮）；新增模型默认不勾选。
    expect(review).toContain("可添加的预设模型");
    expect(review).toContain("已加入，移除请用行删除按钮");
    expect(review).toContain("目录已移除，白名单保留");
    expect(review).toContain("添加所选模型（{pendingIds.length}）");
    expect(review).not.toContain("目录已移除模型保留在供应商与价格中心");
    // 新建预设卡片保持：默认仅勾选目录首位推荐模型（2026-10-07 用户确认，取代默认全选）。
    expect(review).toContain("默认仅勾选目录首位推荐模型");
    expect(review).not.toContain("确认 Agent 可见模型");
    expect(review).toContain("上下文窗口");
    expect(review).toContain("最大输出 Token");
    expect(review).toContain("非缓存输入");
    expect(review).toContain("缓存输入");
    expect(review).toContain("可用 Agent");
    expect(review).toContain("createMode");
    // 币种说明文案已移除（2026-10-07 用户确认）：价格数字本身带 $ / ￥ 前缀，无需再解释。
    expect(review).not.toContain("目录价格按供应商官方原始币种维护");
    expect(review).not.toContain("价格前缀 $ / ￥ 即该币种");
    expect(basic).toContain("自定义设置");
    expect(basic).toContain("接入配置");
    expect(basic).toContain("官方预设");
    expect(basic).toContain("非官方预设");
    expect(basic).toContain("switchChannelMode");
    expect(basic).toContain("请选择官方预设");
    expect(basic).toContain("固定上游地址");
    expect(basic).toContain("非官方预设 URL 等信息自行录入");
    expect(basic).not.toContain("item.name} · {item.note}");
    expect(basic).toContain("presetReview");
    expect(basic).toContain("/api/provider-catalog");
    expect(page).toContain("ProviderCatalogReview");
    expect(page).toContain("providerCatalogReview");
    expect(page).toContain("saved.config.revision");
    expect(page).toContain("applyProviderCatalogSelectionToTarget");
    expect(page).toContain("false");
    // 新建目标选择预设时展示「预设模型确认」面板，由用户勾选要加入 Agent 可见模型的条目。
    expect(page).not.toContain("buildNewTargetCatalogPatch");
    expect(page).toContain("providerCatalogHasChanges");
    expect(page).toContain("!selectedTargetPersisted");
    expect(page).toContain("newTargetShell");
    expect(page).toContain("新建供应商");
    expect(page).not.toContain("setPendingProviderCatalogSelection");
    expect(page).toContain("无差异，无需更新");
  });

  test("新建预设面板展示完整模型卡片，含价格、上下文与峰谷（2026-10-07：存量刷新改为表格后卡片仅新建使用）", async () => {
    const review = await readFile(`${componentDir}/provider-catalog-review.tsx`, "utf8");
    expect(review).toContain("CatalogModelCard");
    expect(review).toContain("scheduleFieldPriceText");
    expect(review).toContain("peakWindowText");
    expect(review).toContain("scheduleHolidayText");
    // 存量刷新改为「只加不减」表格后，逐字段变化标注（catalogChanges）随 DiffGroup 卡片一起移除。
    expect(review).not.toContain("catalogChangeItem");
    // 刷新差异不再只渲染简单 ID 列表，新建流程复用完整模型卡片。
    expect(review).not.toContain('<li key={item.id}><label><input type="checkbox"');
    // 峰谷文案由展示工具生成，单独校验工具输出高峰/闲时字样。
    const display = await readFile("src/lib/token-pricing-display.ts", "utf8");
    expect(display).toContain("高峰");
    expect(display).toContain("闲时");
  });

  test("价格中心永久保留条目，并提供统一取消手工覆盖入口", async () => {
    const dialog = await readFile("src/components/pricing-settings-dialog.tsx", "utf8");
    expect(dialog).not.toContain("删除模型");
    expect(dialog).not.toContain('method: "DELETE"');
    expect(dialog).toContain("取消手工覆盖");
    expect(dialog).not.toContain("恢复官方预设");
    expect(dialog).not.toContain("恢复 LiteLLM");
    expect(dialog).toContain("峰谷价格");
    expect(dialog).toContain("将恢复到当前条目默认的 LiteLLM 值域状态");
    expect(dialog).toContain("将恢复到官方预设值域状态");
    expect(dialog).not.toContain("只替换价格中心当前模型条目；目标级手工覆盖不会被修改");
    expect(dialog).not.toContain("模型能力（只读）");
    expect(dialog).not.toContain("来源信息（只读）");
    expect(dialog).not.toContain("可恢复来源（只读）");
    expect(dialog).not.toContain("selectedModel.catalogSourceHash");
  });

  test("两个全局弹窗 Portal 到 document.body，脱离顶栏白色文字继承（2026-09-06 浅色模式修复）", async () => {
    const dialog = await readFile("src/components/pricing-settings-dialog.tsx", "utf8");
    const catalogDialog = await readFile("src/components/provider-catalog-updates-dialog.tsx", "utf8");
    for (const source of [dialog, catalogDialog]) {
      expect(source).toContain("createPortal");
      expect(source).toContain("document.body");
    }
  });

  test("恢复按钮只对人工覆盖显示，价格中心不提供删除入口", async () => {
    const dialog = await readFile("src/components/pricing-settings-dialog.tsx", "utf8");
    expect(dialog).toContain('selectedModel?.confidence === "user_override"');
    expect(dialog).toContain("restoreSelectedModel()");
    expect(dialog).not.toContain('restoreSelectedModel("catalog")');
    expect(dialog).not.toContain('restoreSelectedModel("litellm")');
    expect(dialog).not.toContain("method: \"DELETE\"");
    expect(dialog).not.toContain("下次目录刷新会自动恢复");
  });

  test("目标模型列表体现峰谷，计费覆盖支持分别覆盖高峰与闲时价格", async () => {
    const resources = await readFile(`${componentDir}/proxy-resources-tab.tsx`, "utf8");
    expect(resources).toContain("峰谷");
    expect(resources).toContain("高峰");
    expect(resources).toContain("闲时");
    // 无峰谷费率的模型只展示普通计费价格，不能出现“高峰价格”误导用户。
    expect(resources).toContain('"计费价格（非缓存输入 / 缓存输入 / 输出）"');
    expect(resources).toContain("hasPeakValley");
    expect(resources).toContain("priceSchedules");
    expect(resources).toContain("scheduleWindowText");
  });

  test("计费覆盖取消入口与编辑范围保持一致，取消失败会在页面提示", async () => {
    const resources = await readFile(`${componentDir}/proxy-resources-tab.tsx`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    expect(resources).toContain("hasGlobalManualOverride");
    expect(resources).toContain("cancelOverrideButton");
    expect(resources).toContain("onRemoveGlobalPrice(pricingEntryRuntimeId, pricingEntryVendor)");
    expect(resources).toContain("onRemoveTargetPrice(modelId)");
    expect(resources).not.toContain('props.onRemoveTargetPrice(modelId)}>取消当前供应商手工覆盖</button></td></tr>');
    expect(resources).not.toContain('props.onRemoveGlobalPrice(entry?.runtimeModelId || entry?.match || modelId');
    expect(page).toContain("取消全局手工覆盖失败");
    expect(resources).toContain("选择“仅当前供应商”即明确要求生成目标级覆盖");
    expect(resources).not.toContain("centerPricing && pricingEquals");
    expect(resources).toContain('updateRate("longContextOutput", event.currentTarget.value)');
    expect(resources).not.toContain('value={rates.longContextOutput} onChange={event => setRates({...rates, output: event.currentTarget.value})}');
    expect(resources).not.toMatch(/set(?:Rates|OffPeakRates)\(current =>[^\n]{0,160}event\.currentTarget\.value/);
    expect(resources).toContain("长上下文档位需同时填写阈值、输入倍率、输出倍率，或全部留空");
    expect(resources).toContain('setSaveError(error instanceof Error ? error.message : "计费价格保存失败，请稍后重试。")');
    expect(resources).not.toContain('catch { /* 错误已由页面 notice 展示 */ } finally');
  });

  test("新建草稿聚焦接入配置：隐藏目标页头部与页签，官方↔非官方切换清空已填内容", async () => {
    const basic = await readFile(`${componentDir}/proxy-basic-tab.tsx`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    // 草稿模式内容区直接渲染新建外壳，不再渲染目标标题、启用开关与四个页签。
    expect(page).toContain("!selectedTargetPersisted ? (");
    expect(page).toContain("newTargetShell");
    expect(page).toContain("新建供应商");
    expect(page).toContain("basicTabElement");
    // 官方预设 / 非官方预设分段选择，默认官方；切换时清空 URL、预设身份与派生的名称/路由 ID。
    expect(basic).toContain("channelMode");
    expect(basic).toContain('useState<"official" | "custom">("official")');
    expect(basic).toContain("switchChannelMode");
    expect(basic).toContain("openaiUrl: undefined,");
    expect(basic).toContain("presetId: undefined,");
    expect(basic).toContain("pricing: {...target.pricing, vendor: undefined}");
    // 官方模式固定地址只读展示；非官方模式才出现两个协议 URL 输入。
    expect(basic).toContain("只读");
    expect(basic).toContain("customMode || !creating");
  });

  test("套餐用量只对声明套餐的供应商展示，DeepSeek 等目标不出现", async () => {
    const overview = await readFile(`${componentDir}/proxy-overview-tab.tsx`, "utf8");
    expect(overview).toContain("resolvePlanProviderForTarget");
    expect(overview).toContain("planProvider || planConfig ? <section");
    expect(overview).toContain("planProviderOptions()");
    expect(overview).not.toContain("defaultPlanProviderType");
  });

  test("无余额接口的账号提示按供应商能力统一渲染", async () => {
    const overview = await readFile(`${componentDir}/proxy-overview-tab.tsx`, "utf8");
    expect(overview).toContain("resolveProviderAccountCapability");
    expect(overview).toContain('resolveProviderAccountCapability(accountDraft.providerType)?.balance === "unsupported"');
    expect(overview).not.toContain("NO_BALANCE_ACCOUNT_PROVIDERS");
  });

  test("无余额官方预设不展示账号信息卡片；账号信息不允许单独删除（随目标整体删除）", async () => {
    const overview = await readFile(`${componentDir}/proxy-overview-tab.tsx`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    expect(overview).toContain("accountSyncSupported");
    expect(overview).toContain("(accountSyncSupported || account) ? <section");
    expect(overview).not.toContain("删除账号");
    expect(overview).toContain("该供应商暂无公开余额接口");
    expect(page).not.toContain("onRemoveAccount");
  });

  test("价格中心保留币种口径提示；Token 价格页不再展示该横幅（2026-09-04 用户确认移除）", async () => {
    const pricingDialog = await readFile("src/components/pricing-settings-dialog.tsx", "utf8");
    const tokenPricing = await readFile("src/components/token-pricing-content.tsx", "utf8");
    const warning = "目录价格按供应商官方原始数值维护，本期统一按人民币口径计费；界面不展示币种符号，币种由你自行判断";
    // 2026-09-06 用户确认：价格中心弹窗的币种口径横幅整体移除。
    expect(pricingDialog).not.toContain(warning);
    expect(tokenPricing).not.toContain(warning);
    expect(tokenPricing).not.toContain("unconvertedCatalogPricing");
  });

  test("价格中心展示上游真实模型 ID，内部价格条目引用保持隐藏", async () => {
    const pricingDialog = await readFile("src/components/pricing-settings-dialog.tsx", "utf8");
    expect(pricingDialog).toContain("runtimeModelIdOf(item)");
    expect(pricingDialog).toContain("runtimeModelId: modelId");
    expect(pricingDialog).not.toContain("<span>{item.id}</span>");
    expect(pricingDialog).toContain("readOnly={!isCreatingModel}");
  });

  test("主页面拆分为顶部 Agent 入口、目标侧栏和四个详情 Tab", async () => {
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    for (const file of [
      "agent-entry-badges.tsx",
      "agent-default-entry-dialog.tsx",
      "proxy-target-sidebar.tsx",
      "proxy-overview-tab.tsx",
      "proxy-basic-tab.tsx",
      "proxy-resources-tab.tsx",
      "proxy-agent-tab.tsx",
      "connect-agent-dialog.tsx",
      "proxy-onboarding-wizard.tsx",
      "proxy-management.module.css",
    ]) {
      expect(existsSync(`${componentDir}/${file}`), file).toBe(true);
    }
    for (const label of ["概览", "基础配置", "密钥与模型", "Agent 接入"]) {
      expect(page).toContain(label);
    }
    expect(page).not.toContain("同步与诊断");
    expect(page).not.toContain("同步 CLI");
    // 左侧不再有「各 Agent 默认入口」列表，改为顶部已接入 Agent logo 行 + 即时生效弹窗。
    expect(page).not.toContain("AgentEntryList");
    expect(page).toContain("AgentEntryBadges");
    expect(page).not.toContain("AgentDefaultEntryDialog");
    expect(page).toContain("DevelopmentLaunchDialog");
    expect(page).toContain("setDevelopmentTarget");
    expect(page).toContain("ProxyTargetSidebar");
  });

  test("向导步骤条按官方两步或自定义三步自适应均分，不保留旧四步空列", async () => {
    const css = await readFile(`${componentDir}/proxy-management.module.css`, "utf8");
    const wizardSteps = css.slice(css.indexOf(".wizardSteps"), css.indexOf(".wizardStep {"));
    expect(wizardSteps).toContain("repeat(auto-fit, minmax(140px, 1fr))");
    expect(wizardSteps).not.toContain("repeat(4");
  });

  test("Agent 页按当前目标绑定关系展示接入状态，并提供非默认目标解除绑定", async () => {
    const agentTab = await readFile(`${componentDir}/proxy-agent-tab.tsx`, "utf8");
    expect(agentTab).toContain("boundTargetIds.includes(target.id)");
    expect(agentTab).toContain("解除绑定");
    expect(agentTab).toContain("onUnbindAgent");
    // 不支持的 Agent 不再展示「暂不可选」提示，卡片区只渲染协议/模型/密钥齐全的 Agent。
    expect(agentTab).not.toContain("暂不可选");
    expect(agentTab).not.toContain("不支持 Codex Responses");
    expect(agentTab).toContain("targetSupportsAgent(target, entry.id, credentials)");
  });

  test("停用保存失败时不继续切换默认链，删除清理失败明细不会被当成成功", async () => {
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    expect(page).toContain("if (!disabledSaved) return");
    expect(page).toContain("purgeResult.failed");
    expect(page).not.toContain("await patchSelectedTarget({enabled: false}, \"供应商已停用。\").catch(() => undefined)");
  });

  test("新建目标不复用旧凭据缓存跳步，删除或回退目标统一同步 URL", async () => {
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    const wizard = await readFile(`${componentDir}/proxy-onboarding-wizard.tsx`, "utf8");
    expect(page).toContain("resolveProxyOnboardingStartStep");
    expect(page).toContain("isNewTarget: true");
    expect(page).toContain("requireCredentialEntry: true");
    expect(page).toContain("syncSelectedTargetUrl");
    expect(page).toContain("delete next[selectedTarget.id]");
    expect(wizard).toContain('if (!requireCredentialEntry && step === "credentials" && targetCredentials.length > 0)');
  });

  test("官方预设新建通过单次服务端命令完成，不再留下半成品目标", async () => {
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    expect(page).toContain('action: "create"');
    expect(page).not.toContain("官方预设目录应用失败");
    expect(page).not.toContain("供应商已创建，但");
  });

  test("顶部 Agent 默认入口：只展示已接入 Agent，弹窗即时生效无保存按钮", async () => {
    const badges = await readFile(`${componentDir}/agent-entry-badges.tsx`, "utf8");
    const dialog = await readFile(`${componentDir}/agent-default-entry-dialog.tsx`, "utf8");
    const connect = await readFile(`${componentDir}/connect-agent-dialog.tsx`, "utf8");
    // 顶部 logo 行只展示已接入的 Agent。
    expect(badges).toContain("boundCompatibleTargetsForAgent(config, entry.id).length > 0");
    expect(badges).toContain("/agent-logos/");
    expect(badges).not.toContain("尚未接入 Agent");
    // 弹窗：顶部「在 XXX 中开发」+ 默认供应商/模型/密钥即时生效，无保存/取消按钮。
    expect(dialog).toContain("在 {label} 中开发");
    expect(dialog).toContain("默认供应商");
    expect(dialog).toContain("默认模型");
    expect(dialog).toContain("默认密钥");
    expect(dialog).not.toContain("保存设置");
    expect(dialog).not.toContain("取消");
    expect(dialog).toContain("onSetDefaultTarget");
    expect(dialog).toContain("onSetDefaultModel");
    expect(dialog).toContain("onSetDefaultCredential");
    // Claude 别名仍留在 Agent 接入页的 Claude 卡片配置区。
    const agentTab = await readFile(`${componentDir}/proxy-agent-tab.tsx`, "utf8");
    expect(agentTab).toContain("Opus / Sonnet / Haiku 全局别名");
    expect(agentTab).toContain("onUpdateAliases");
    expect(agentTab).toContain("claudeAliasModelOptions(config)");
    // 接入弹窗（ConnectAgentDialog）保留用于「接入新 Agent」场景。
    expect(connect).toContain("暂不选择供应商");
    expect(connect).not.toContain("CLI 同步");
    expect(connect).toContain("cliSyncEnabled: true");
    expect(connect).toContain("isAgentConnected(config, agent) ? config.agentConnections[agent] : undefined");
  });

  test("目标列表不展示协议，详情保留价格、密钥、Agent 预览，概览承载账号信息", async () => {
    const sidebar = await readFile(`${componentDir}/proxy-target-sidebar.tsx`, "utf8");
    const resources = await readFile(`${componentDir}/proxy-resources-tab.tsx`, "utf8");
    const agent = await readFile(`${componentDir}/proxy-agent-tab.tsx`, "utf8");
    const overview = await readFile(`${componentDir}/proxy-overview-tab.tsx`, "utf8");
    expect(sidebar).not.toContain("OpenAI 协议");
    expect(sidebar).not.toContain("Anthropic 协议");
    for (const label of ["供应商（价格中心）", "非缓存输入", "缓存输入", "输出", "计费覆盖", "密钥指纹", "价格倍率"]) {
      expect(resources).toContain(label);
    }
    // priceEntryId 是内部字段，不再作为表格列向用户展示。
    expect(resources).not.toContain("<th>priceEntryId</th>");
    expect(agent).not.toContain("当前供应商贡献预览");
    expect(agent).toContain("受管配置文件");
    expect(agent).not.toContain("高级 CLI 配置");
    // 账号信息与密钥同步模块搬到概览，删除配置入口移除，删除目标放在概览。
    expect(overview).toContain("账号信息");
    expect(overview).toContain("立即同步");
    expect(overview).toContain("密钥同步");
    expect(overview).toContain("删除供应商");
    expect(overview).not.toContain("删除配置");
  });

  test("响应式样式定义桌面、折叠侧栏和移动单栏", async () => {
    const css = await readFile(`${componentDir}/proxy-management.module.css`, "utf8");
    expect(css).toContain("grid-template-columns: 320px minmax(0, 1fr)");
    expect(css).toContain("@media (max-width: 1099px)");
    expect(css).toContain("@media (max-width: 767px)");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain(":focus-visible");
    expect(css).toContain(".sidebarClose");
    expect(css).toContain("visibility: hidden");
    expect(css).toContain("visibility: visible");
  });

  test("表单、主操作与图标操作均保留至少 44px 的可点击热区", async () => {
    const css = await readFile(`${componentDir}/proxy-management.module.css`, "utf8");
    expect(css).toContain("--pm-control-size: 44px");
    expect(css).toContain("min-height: var(--pm-control-size)");
    expect(css).toContain("width: var(--pm-control-size)");
    expect(css).toContain("height: var(--pm-control-size)");
  });

  test("详情页签与接入弹窗提供完整键盘和焦点语义", async () => {
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    const dialog = await readFile(`${componentDir}/connect-agent-dialog.tsx`, "utf8");
    expect(page).toContain('role="tablist"');
    expect(page).toContain('role="tab"');
    expect(page).toContain("aria-selected={activeTab === tab.id}");
    expect(page).toContain('role="tabpanel"');
    expect(page).toContain('event.key === "ArrowRight"');
    expect(page).toContain('event.key !== "ArrowLeft"');
    expect(page).toContain("handleTabKeyDown(event, tab.id)");
    expect(dialog).toContain('event.key === "Escape"');
    expect(dialog).toContain('event.key !== "Tab"');
    expect(dialog).toContain("previouslyFocused?.focus()");
    expect(dialog).toContain("closeButtonRef.current?.focus()");
  });

  test("基础配置：上游 URL 置顶并按先输入协议自动派生名称/路由 ID", async () => {
    const basic = await readFile(`${componentDir}/proxy-basic-tab.tsx`, "utf8");
    // 上游 URL 区域在最上面，使用协议语义新文案。
    expect(basic).toContain("OpenAI 协议（支持 chat/completions、responses）上游 URL");
    expect(basic).toContain("Anthropic 协议（支持 v1/messages）上游 URL");
    // 代理名称、路由 ID 位于 Anthropic 上游 URL 之后，且由 URL 自动派生、可手动修改。
    expect(basic).toContain("deriveProxyTargetPatchFromBaseUrl");
    expect(basic).toContain("哪个协议 URL 先输入");
    expect(basic).toContain("官方预设置顶选择，两个协议 URL 至少填写一种");
    expect(basic).toContain("自定义设置");
    // 新建预设的目录候选位于“自定义设置”折叠区，而非首屏独立操作。
    expect(basic).toContain("advancedSettings");
    expect(basic).toContain("ProviderCatalogReview");
    expect(basic).toContain("onConfirmPresetReview");
    // 无变化时「确认修改」置灰；新建时官方未选预设、非官方未填 URL 也禁止提交。
    expect(basic).toContain("disabled={busy || !dirty || createDisabled}");
    expect(basic).toContain("createDisabled");
    expect(basic).toContain("disabled={presetLocked}");
    expect(basic).toContain("presetPickerLocked");
    expect(basic).toContain("(!creating && (!routeIdLocked || selectedPresetId))");
    expect(basic).toContain("未填写 · 例如 https://api.example.com/v1");
    // 路由 ID 保存后锁定，并在文案上备注。
    expect(basic).toContain("readOnly={routeIdLocked}");
    expect(basic).toContain("路由 ID 只能新建时填写，创建之后不允许修改。");
    // 路由 ID 保存后只读置灰；本地请求入口预览模块已整体移除（编辑/查看态并入基础信息页签）。
    expect(basic).toContain("aria-disabled={routeIdLocked}");
    expect(basic).not.toContain("本地请求入口预览");
  });

  test("启用开关移到头部公共区且受前置条件控制，入口预览按已接入 Agent 联动展示", async () => {
    const basic = await readFile(`${componentDir}/proxy-basic-tab.tsx`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    // 启用开关移到右侧正文头部（开关 + 已启用/未启用文案），前置条件不足时给出补齐提示。
    expect(page).toContain("toggleTargetEnabled");
    expect(page).toContain("启用前需补齐");
    expect(page).toContain("enableSwitch");
    expect(page).toContain("已启用");
    expect(page).toContain("未启用");
    // 基础配置不再承载启用开关。
    expect(basic).not.toContain("启用供应商");
    // 本地请求入口预览模块已整体删除，不再有联动展示。
    expect(basic).not.toContain("AGENT_CATALOG");
    expect(basic).not.toContain("本地请求入口预览");
  });

  test("概览检查清单按向导流程分场景展示，前置未完成时后续置灰", async () => {
    const overview = await readFile(`${componentDir}/proxy-overview-tab.tsx`, "utf8");
    const wizard = await readFile(`${componentDir}/proxy-onboarding-wizard.tsx`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    expect(overview).toContain("启用前（接入就绪度）检查清单");
    // 按向导步骤：自定义目标含「模型发现与确认」，官方预设跳过模型步骤。
    expect(overview).toContain("模型发现与确认");
    expect(overview).toContain("设置 API 密钥");
    expect(overview).toContain("启用供应商");
    expect(overview).toContain("接入 Agent（选择可用 Agent）");
    // 接入 Agent 是向导最后一步，放在清单末尾。
    expect(overview.indexOf("接入 Agent（选择可用 Agent）"))
      .toBeGreaterThan(overview.indexOf("启用供应商"));
    // 官方预设场景不展示模型步骤。
    expect(overview).toContain("resolveOfficialPresetForTarget");
    expect(overview).toContain("officialPreset");
    // 前置未完成时后续置灰，禁止跨流程。
    expect(overview).toContain("blocked: index > 0 && !items.slice(0, index).every(prev => prev.ok)");
    expect(overview).toContain("checklistRowBlocked");
    expect(overview).toContain("请先完成上一步骤");
    expect(overview).toContain("onStartOnboarding");
    expect(page).toContain("onStartOnboarding={() => {");
    // 向导与清单共用步骤定义。
    expect(wizard).toContain("ONBOARDING_STEPS");
  });

  test("新建分步引导向导：自动完成密钥与模型流程，最后只选择 Agent", async () => {
    const wizard = await readFile(`${componentDir}/proxy-onboarding-wizard.tsx`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    const proxyConfig = await readFile("src/proxy-config.ts", "utf8");
    // 三步线性：API密钥 → 模型发现与确认 → 接入 Agent 并完成。
    expect(wizard).toContain("{id: \"discover\", label: \"模型发现与确认\"}");
    expect(wizard).toContain("{id: \"credentials\", label: \"API密钥\"}");
    expect(wizard).toContain("{id: \"agent\", label: \"接入 Agent 并完成配置\"}");
    // 模型发现自动使用默认密钥（多密钥时可切换下拉），探测结果确认后才写入 Agent 可见模型。
    expect(wizard).toContain("onDiscoverModels");
    expect(wizard).toContain("onConfirmDiscoveredModels");
    expect(wizard).toContain("onDiscoverModels(discoverCredentialId)");
    expect(wizard).toContain("未发现可唯一匹配价格中心的模型");
    // 多密钥（>1）时提供「模型发现密钥」下拉；单密钥不渲染、无手动探测按钮。
    expect(wizard).toContain("targetCredentials.length > 1");
    expect(wizard).toContain("模型发现密钥</span>");
    expect(wizard).not.toContain("探测上游模型</button>");
    expect(wizard.match(/确认模型并继续/gu)).toHaveLength(1);
    // 已有与目标 Agent wire 兼容的模型时可跳过探测直接接入。
    expect(wizard).toContain("skipDiscoveryAgents");
    expect(wizard).toContain("已有兼容模型，直接接入");
    // Agent 多选；URL 和官方预设 wire API 能力均不满足时不可选。
    expect(wizard).toContain("resolveTargetAgentCapability");
    expect(wizard).toContain("const [selectedAgents, setSelectedAgents]");
    // 默认模型、默认密钥和首次默认代理目标由服务端自动补齐；向导不展示步骤说明文案。
    expect(wizard).not.toContain("默认模型由系统自动设置");
    expect(wizard).toContain("API密钥及价格倍率设置");
    expect(proxyConfig).toContain("const implicitDefaultTargetId");
    expect(page).toContain("首次默认供应商由服务端统一补齐");
    // 为指定 Agent 接入时保留初始 Agent 选择。
    expect(wizard).toContain("initialAgents");
    // 最后一步：启用目标 → 按所选 Agent 建立接入 → CLI 同步。
    expect(wizard).toContain("onSaveTargetPatch({enabled: true}");
    expect(wizard).toContain("onConnectAgent(agent)");
    expect(wizard).toContain("onSyncCli()");
    // 向导不展示默认模型、默认代理、数量统计和配置预览。
    expect(wizard).not.toContain("设为该 Agent 默认代理供应商");
    expect(wizard).not.toContain("将写入的配置预览");
    expect(wizard).not.toContain("deepaa_gateway");
    // 只接入部分 Agent 时，系统按 wire API 兼容性合并模型归属（如模型发现只写入 codex 时并入 opencode）。
    expect(wizard).toContain("wireApiCompatibleModelsForTarget(target, agent)");
    expect(wizard).toContain("nextScopes[modelId] = merged");
    // 已接入该供应商的 Agent 默认选中且置灰不可取消，避免重复接入/误取消。
    expect(wizard).toContain("alreadyConnected");
    expect(wizard).toContain("disabled={!available || alreadyConnected}");
    // 已有密钥的供应商接入新 Agent 时，自动补齐密钥适用与默认密钥，避免「接入后不显示」。
    expect(wizard).toContain("credentialBackfill");
    expect(wizard).toContain("补齐密钥适用");
    expect(wizard).toContain("defaultCredentials[agent] === undefined");
    // 页面：保存草稿后直接打开向导，并渲染向导组件。
    expect(page).toContain("setOnboardingStep(first ? {step: first, requireCredentialEntry: true} : null)");
    expect(page).toContain("<ProxyOnboardingWizard");
    expect(page).toContain("onCreateCredential={createCredential}");
  });

  test("向导 Agent 步「本次关联模型」：默认仅关联默认模型，已记录适用不再全量并集（2026-10-07 用户确认）", async () => {
    const wizard = await readFile(`${componentDir}/proxy-onboarding-wizard.tsx`, "utf8");
    expect(wizard).toContain("本次关联模型");
    expect(wizard).toContain("associateModelOverride");
    expect(wizard).toContain("defaultAssociateModelIds");
    expect(wizard).toContain("associateModelSet");
    // 已记录适用且不在「本次关联模型」勾选集内的模型保持原适用，不并入新 Agent。
    expect(wizard).toContain("if (hasRecordedScope && !associateModelSet.has(modelId)) continue;");
    // 未记录适用的模型仍按既有语义收紧到所选 Agent（AGENTS.md 2026-09-08）。
    expect(wizard).toContain("const hasRecordedScope = Array.isArray(target.supportedModelScopes?.[modelId]);");
    // 默认关联集与完成阶段默认模型判定同源：显式默认优先 → 兼容交集第一位 → 该 Agent 首个兼容。
    expect(wizard).toContain("explicit && models.includes(explicit)");
  });

  test("向导 Agent 默认不预勾（2026-10-10 用户确认）：新建为空、重开按接入事实推导，「本次关联模型」文案收敛", async () => {
    const wizard = await readFile(`${componentDir}/proxy-onboarding-wizard.tsx`, "utf8");
    // 新建供应商（requireCredentialEntry）不预勾任何 Agent，完成阶段校验至少一个。
    expect(wizard).toContain("(initialAgents\n    || (requireCredentialEntry ? [] : deriveOnboardingAgents(target, credentials, config)))");
    expect(wizard).toContain("请至少选择一个 Agent");
    // deriveOnboardingAgents 只从真实接入事实（密钥适用 + Agent 绑定）推导；
    // 模型适用范围（supportedModelScopes，预设建目标写入全部兼容 Agent）不再是勾选来源。
    expect(wizard).not.toContain("Object.values(target.supportedModelScopes");
    // 「本次关联模型」说明文案（2026-10-10 用户确认改版）。
    expect(wizard).toContain("把所选 Agent 关联到本次默认勾选的模型，其余模型可稍后在「密钥与模型」页签进行添加使用");
  });

  test("官方直连观测文案（2026-10-10 用户确认）：向导一句话口径，「密钥与模型」页签移除，基础信息套餐用量常驻深绿详述", async () => {
    const hint = await readFile(`${componentDir}/zcode-local-import-hint.tsx`, "utf8");
    const resources = await readFile(`${componentDir}/proxy-resources-tab.tsx`, "utf8");
    const overview = await readFile(`${componentDir}/proxy-overview-tab.tsx`, "utf8");
    const css = await readFile(`${componentDir}/proxy-management.module.css`, "utf8");
    // 向导：一句话口径，仅智谱 Coding Plan 预设 + 含 zcode 时渲染；variant prop 随页签用法一并移除。
    expect(hint).toContain("为了享用智谱官方的套餐积分折扣，智谱官方限制只能在他们自己的 ZCode 客户端才能享用，请关注使用");
    expect(hint).not.toContain("variant");
    expect(resources).not.toContain("ZcodeLocalImportHint");
    // 基础信息「套餐用量」标题正下方：智谱官方预设常驻深绿详述（不限是否已接入 ZCode）；
    // 段落位于 header 左列（cardHeaderMain 占满剩余宽度），接近右侧「修改套餐」即自然换行。
    expect(overview).toContain('target.presetId === "zhipu-coding-plan"');
    expect(overview).toContain("planDirectObserveNote");
    expect(overview).toContain("cardHeaderMain");
    expect(overview).toContain("为了享用官方 ZCode 的专有积分折扣（打折67%）");
    expect(overview).toContain("ZCode 客户端签名机制限制，经网关流量不享受ZCode专有折扣");
    expect(css).toContain(".cardHeaderMain");
    expect(css).toContain(".cardHeader .planDirectObserveNote");
  });

  test("套餐档位 + 付款周期下拉（2026-10-10 用户确认）：目录含周期价供应商单选必选默认不选，联动折算月价", async () => {
    const overview = await readFile(`${componentDir}/proxy-overview-tab.tsx`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    // 下拉只在「多档位且含付款周期折算价」供应商展示（OpenCode Go 维持原档位 radio）。
    expect(overview).toContain("tierCycleSelectsEnabled");
    expect(overview).toContain('planDraft.providerType !== "opencode-go"');
    // 单选下拉、默认不选、保存时必选校验（用户显式确认，自动回填才精准）。
    expect(overview).toContain('<option value="">请选择套餐档位</option>');
    expect(overview).toContain('<option value="">请选择付款周期</option>');
    // 档位选项只展示档位名：金额随付款周期变化，不随档位写死在选项里（2026-10-10 用户确认）。
    expect(overview).not.toContain("{tier.monthlyFee}/月）</option>");
    expect(overview).toContain('setPlanError("请选择套餐档位")');
    expect(overview).toContain('setPlanError("请选择付款周期")');
    // 档位 × 周期联动目录折算月价；手动改写月费后不再自动覆盖。
    expect(overview).toContain("resolvePlanTierFee");
    expect(overview).toContain("planFeeTouched");
    // 周期标签值域与目录 billingCycles 键一致。
    expect(overview).toContain('{value: "monthly", label: "按月"}');
    expect(overview).toContain('{value: "quarterly", label: "按季"}');
    expect(overview).toContain('{value: "yearly", label: "按年"}');
    // 摘要区展示已保存档位与周期。
    expect(overview).toContain("<dt>付款周期</dt>");
    // 页面保存链：非 opencode-go 档位/周期走目标 pricing 补丁与月费同链落盘（plan-config
    // API 对其它供应商档位 PLAN_TIER_UNSUPPORTED），opencode-go 档位仍由服务端校验落盘。
    expect(page).toContain("planTier: input.providerType === \"opencode-go\" ? input.planTier : undefined");
    expect(page).toContain("planBillingCycle: input.planBillingCycle");
  });

  test("价格中心选择器默认按当前供应商过滤，可手动取消；服务端 vendor 查询 + 100/页分页（2026-10-07 修复）", async () => {
    const resources = await readFile(`${componentDir}/proxy-resources-tab.tsx`, "utf8");
    const wizard = await readFile(`${componentDir}/proxy-onboarding-wizard.tsx`, "utf8");
    const picker = await readFile(`${componentDir}/use-pricing-catalog-picker.ts`, "utf8");
    for (const source of [resources, wizard]) {
      expect(source).toContain("pricingVendorOnly");
      expect(source).toContain("仅显示 {pricingVendorFilter}");
      // 选择器复用共享取数 hook（服务端 vendor/search 查询），并关闭客户端二次过滤。
      expect(source).toContain("usePricingCatalogPicker");
      expect(source).toContain("filterOptions={false}");
      // 选择器自驱动取数，不再联动共享列表搜索，也不得改共享全量加载链路。
      expect(source).not.toContain("onPricingSearch");
      expect(source).not.toContain("vendors=");
    }
    expect(resources).toContain("resolveOfficialPresetForTarget(target)?.vendor ?? target.pricing?.vendor");
    // 共享 hook：服务端 vendor 参数 + 100/页累积分页（官方预设场景通常不足一页全量直出），
    // 修复「客户端在 limit=200 截断列表上按 vendor 过滤 → opencode-go 等条目被滤空」的事故。
    expect(picker).toContain('params.set("vendor", effectiveVendor)');
    expect(picker).toContain("PRICING_PICKER_PAGE_SIZE = 100");
    expect(picker).toContain("loadMore");
    // 全部条目都列出（含已加入，2026-10-07 用户确认）；「已加入」判定必须条目级
    // （模型 × 供应商，按目标 modelVendors 映射命中）：同名绑定其它供应商的行标「同名已加入」
    // 同样置灰——一个模型名只有一条价格映射，点击同名条目无法产生新映射。
    expect(picker).toContain('status: !nameAdded ? "可加入" : thisEntryAdded ? "已加入" : "同名已加入"');
    expect(picker).toContain("mapping.priceEntryId === entry.id");
    for (const source of [resources, wizard]) {
      expect(source).toContain("supportedModels: target.supportedModels");
      expect(source).toContain("modelVendors: target.pricing?.modelVendors");
    }
    // 搜索词家族自动过滤（2026-10-07 用户确认，四类）：claude→anthropic / gpt→openai /
    // grok→xai / gemini→gemini，默认勾选「仅显示 {vendor}」、可取消看全部；仅无显式
    // 供应商过滤时生效（官方预设的「仅显示」优先）。
    for (const item of ["claude", "gpt", "grok", "gemini"]) {
      expect(picker).toContain(`pattern: /${item}/iu`);
    }
    expect(picker).toContain("familyOnly");
    for (const source of [resources, wizard]) {
      expect(source).toContain("searchable-select-accessory");
      expect(source).toContain("仅显示 {pricingPicker.familyVendor}");
    }
    // 添加入口直接消费 picker 条目，不依赖共享 200 条列表回查（否则选中项可能查不到而静默失败）。
    expect(resources).toContain("pricingPicker.findEntryById(value)");
    expect(wizard).toContain("pricingPicker.findEntryById(value)");
  });

  test("官方预设向导动态跳过模型发现，自定义目标保留模型发现", async () => {
    const wizard = await readFile(`${componentDir}/proxy-onboarding-wizard.tsx`, "utf8");
    const resources = await readFile(`${componentDir}/proxy-resources-tab.tsx`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    expect(wizard).toContain("onboardingStepsForTarget");
    expect(wizard).toContain("isOfficialPresetTarget");
    expect(page).toContain("resolveProxyOnboardingStartStep");
    expect(page).toContain("presetId");
    expect(resources).toContain("isOfficialPresetTarget");
    expect(resources).toContain("预设目录模型");
  });

  test("向导自动保存首个密钥并进入发现，发现与 Agent 步骤只保留必要交互", async () => {
    const wizard = await readFile(`${componentDir}/proxy-onboarding-wizard.tsx`, "utf8");
    expect(wizard).toContain("const next = steps.find(item => item.id !== \"credentials\")");
    expect(wizard).toContain("onDiscoverModels(discoverCredentialId)");
    expect(wizard).toContain("API密钥及价格倍率设置");
    expect(wizard).toContain("设置密钥</div>");
    expect(wizard).not.toContain("探测上游模型</button>");
    expect(wizard).not.toContain("设为该 Agent 默认代理供应商");
    expect(wizard).not.toContain("将写入的配置预览");
    expect(wizard).not.toContain("支持的模型</dt>");
    expect(wizard).not.toContain("系统密钥</dt>");
  });

  test("切换官方预设时先清理上一预设的模型选择，避免提交陈旧模型 ID", async () => {
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    expect(page).toContain("if (!selectedTargetPersisted) setPresetSelectedModelIds(undefined);");
  });

  test("Agent 向导可选项统一经过预设协议能力门禁，不能只检查 URL", async () => {
    const wizard = await readFile(`${componentDir}/proxy-onboarding-wizard.tsx`, "utf8");
    expect(wizard).toContain("resolveTargetAgentCapability(target, entry.id).supported");
    expect(wizard).not.toContain("AGENT_CATALOG.filter(entry => targetHasProtocolForAgent(target, entry.id))");
  });

  test("Agent 接入页签：未接入时给出明确引导，不再展示看似已填的下拉", async () => {
    const agentTab = await readFile(`${componentDir}/proxy-agent-tab.tsx`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    // 未接入的 Agent 有「接入 X」主按钮和说明，默认模型/密钥下拉只对接入后展示。
    expect(agentTab).toContain("接入其他 Agent");
    expect(agentTab).toContain("已支持全部可用 Agent");
    expect(agentTab).toContain("targetSupportsAgent");
    expect(agentTab).toContain("targetPersisted");
    expect(agentTab).toContain("当前供应商尚未接入任何 Agent");
    // 不支持的 Agent 彻底隐藏：不再出现 notSupported 列表与「暂不可选」提示。
    expect(agentTab).not.toContain("notSupported");
    expect(agentTab).toContain("AGENT_CATALOG.filter(entry => targetSupportsAgent(target, entry.id, credentials))");
    // 可接入列表按协议能力判定：链路不完整（如密钥适用被取消）的 Agent 仍可从「接入其他 Agent」恢复。
    expect(agentTab).toContain("targetHasProtocolForAgent(target, entry.id)");
    expect(agentTab).toContain("wireApiCompatibleModelsForTarget(target, entry.id).length > 0");
    expect(agentTab).toContain("配置数据同步");
    expect(agentTab).toContain("cliStatus");
    expect(agentTab).toContain("接入 {label}");
    expect(page).toContain("onConnectAgent={agent => openOnboardingWizard(agent)}");
    expect(agentTab).toContain("onConnectAgent(connectable[0]?.id)");
    // 链接中的目标不存在时提示回退，避免用户以为在看旧目标。
    expect(page).toContain("链接中的供应商");
    expect(page).toContain("在当前配置中不存在，已切换到");
  });

  test("新建草稿路由 ID 为空，保存时按上游 URL 派生并直接进入分步引导", async () => {
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    // 新建草稿不再生成随机占位路由 ID。
    expect(page).not.toContain("new-target-${Date.now()}");
    expect(page).toContain("id: \"\"");
  // 保存时兜底按统一候选链（主域优先五层链，同 URL 对与候选用尽分别报错）派生全局唯一路由 ID。
  expect(page).toContain("resolveDerivedRouteId(openaiUrl, anthropicUrl || undefined, otherTargets)");
    // 新建提交后切到概览页并直接打开分步引导向导，不再弹「已保存」浮窗。
    expect(page).toContain("setActiveTab(\"info\")");
    expect(page).not.toContain("已打开分步引导，按步骤完成即可启用");
    expect(page).toContain("向导本身就是引导");
    expect(page).toContain("firstMissingOnboardingStep");
    // 启用开关的前置条件与已接入 Agent 传入页签。
    expect(page).toContain("targetCanEnable");
    expect(page).toContain("enableBlockers.join");
    expect(page).toContain("agentConnections={config.agentConnections}");
    // 持久化判定按 createdAt 身份匹配，避免草稿路由 ID 撞名被误判为已保存目标。
    expect(page).toContain("target.id === selectedTarget.id && target.createdAt === selectedTarget.createdAt");
  });

  test("密钥与模型页签保留价格中心搜索选择器，选择器自驱动取数不联动共享列表（2026-10-07）", async () => {
    const resources = await readFile(`${componentDir}/proxy-resources-tab.tsx`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    expect(resources).toContain("SearchableSelect");
    expect(resources).toContain("搜索价格中心模型添加");
    expect(resources).toContain("searchPlaceholder=");
    expect(resources).not.toContain("<select value={modelToAdd}");
    expect(resources).toContain("usePricingCatalogPicker");
    expect(resources).toContain("onOpenPricingCenter");
    expect(resources).toContain("价格中心</button> 添加模型");
    // 选择器改为服务端 vendor/search 专用取数后，与页面共享列表的搜索联动解耦。
    expect(resources).not.toContain("onPricingSearch");
    expect(page).not.toContain("onPricingSearch={setPricingSearch}");
    expect(page).not.toContain("pricingModelLoading={");
    expect(page).toContain("onOpenPricingCenter={openPricingCenter}");
  });

  test("模型归属随已接入 Agent 联动，计费覆盖默认带入基础价格", async () => {
    const resources = await readFile(`${componentDir}/proxy-resources-tab.tsx`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    // Agent 归属选项来自已接入 Agent，使用精筛下拉（确认修改后生效）。
    expect(resources).toContain("connectedAgents");
    expect(resources).toContain("scopeOptions: AgentScopeOption[]");
    expect(resources).toContain("AgentScopePicker");
    expect(page).toContain("connectedAgents={connectedAgentsList}");
    // 计费覆盖展开时默认带入生效价格（2026-10-09 B1：手工覆盖优先，无覆盖且官方
    // 促销生效时带入促销价——与收起态展示一致，编辑器内提示保存即固化），
    // 保存覆盖即时落库并收起编辑行。
    expect(resources).toContain("const seedRates = displayOverride?.pricing");
    expect(resources).toContain("overlayDisplayRates(entry.pricing, activePromotion.priceOverride)");
    expect(resources).toContain("保存将固化为手工覆盖");
    expect(resources).toContain("onSaveTargetPatch");
    expect(resources).not.toContain("保存模型设置");
    expect(resources).toContain("onCollapse()");
    // 默认模型/密钥徽章。
    expect(resources).toContain("defaultAgents");
    expect(resources).toContain("默认</span>");
  });

  test("接入弹窗：作为默认供应商勾选框、首次默认勾选与改默认确认", async () => {
    const dialog = await readFile(`${componentDir}/connect-agent-dialog.tsx`, "utf8");
    // 有目标上下文时用「作为默认供应商」勾选框替代默认供应商下拉。
    expect(dialog).toContain("作为默认供应商");
    expect(dialog).toContain("currentTargetId");
    expect(dialog).toContain("首次接入不自动勾选默认代理供应商");
    // 该 Agent 已有其它默认目标时，勾选需确认。
    expect(dialog).toContain("confirmDialog");
    expect(dialog).toContain("确认改为当前供应商");
    // 取消勾选 = 只建立绑定并保留原默认。
    expect(dialog).toContain("asDefault ? currentTargetId : undefined");
    // 模型/密钥跟随当前代理目标，文案标注清楚。
    expect(dialog).toContain("当前供应商下的默认模型");
    expect(dialog).toContain("当前供应商下的默认密钥");
    expect(dialog).toContain("默认模型与密钥跟随当前供应商");
    // 全部已接入时不得回退到 Codex 编辑模式。
    expect(dialog).toContain("所有 Agent 都已接入");
  });

  test("概览承载密钥同步与账号信息，开发弹窗网关地址按 Agent 区分", async () => {
    const overview = await readFile(`${componentDir}/proxy-overview-tab.tsx`, "utf8");
    const types = await readFile(`${componentDir}/proxy-management-types.ts`, "utf8");
    const launch = await readFile("src/components/development-launch-dialog.tsx", "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    // warnings 是 {targetId, code, message} 对象数组，渲染 message，不再把对象当 React 子元素。
    expect(types).toContain("warnings?: Array<{targetId: string; code: string; message: string}>");
    // 网关地址与注入一致：2026-09-14 起由注册表按 defaultBinding 协议推导
    // （openai→/{agent}/v1，anthropic→/{agent}），弹窗不再手写 URL 分支。
    expect(launch).toContain("localProxyBaseUrl");
    expect(launch).toContain("agentGatewayEntryUrl(cli, gatewayBaseUrl)");
    expect(launch).not.toContain("http://localhost:3211/v1");
    expect(page).toContain("localProxyBaseUrl={config.localProxyBaseUrl");
    // 概览：密钥同步（系统密钥 vs 对方网站密钥）、自动同步频率、下次同步时间。
    expect(overview).toContain("密钥同步");
    expect(overview).toContain("credentialComparison");
    expect(overview).toContain("同步失败");
    expect(overview).toContain("自动同步一次");
    expect(overview).toContain("下次同步");
    expect(overview).toContain("formatRelativeFuture");
    expect(types).toContain("syncIntervalMinutes: number;");
    // 同步周期下拉与旁白备注；保存后立即同步失败立刻提醒（首次/再次按场景区分）。
    expect(overview).toContain("同步周期");
    expect(overview).toContain("约每 {accountIntervalDisplay} 分钟自动同步一次");
    expect(page).toContain("再次同步");
    expect(page).toContain("首次同步");
    expect(page).toContain("assertImmediateSyncOk");
  });

  test("套餐同步显式选择密钥并展示时间窗进度、过期状态与原始价格口径", async () => {
    const overview = await readFile(`${componentDir}/proxy-overview-tab.tsx`, "utf8");
    const types = await readFile(`${componentDir}/proxy-management-types.ts`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    const sharedTypes = await readFile("src/types.ts", "utf8");
    // 套餐适配器标签的唯一来源已收敛到 provider-plugins/meta（P1-9）。
    const providerMeta = await readFile("src/lib/provider-plugins/meta.ts", "utf8");
    // 套餐同步与控制台账号是两条独立链路；API Key 必须显式选择，不回退默认密钥。
    expect(overview).toContain("套餐用量");
    expect(overview).toContain("套餐同步密钥");
    expect(overview).toContain("请选择当前供应商的一条密钥");
    expect(overview).toContain("volcengine-plan");
    expect(overview).toContain("AccessKey ID");
    expect(overview).toContain("SecretAccessKey");
    expect(page).toContain('mode: "plan"');
    expect(page).toContain("expectedRevision: persistedConfigRef.current.revision");
    expect(page).toContain("onSavePlanConfig={savePlanSyncConfig}");
    // 套餐表单提交必须携带同步周期，否则修改周期不生效（服务端缺省=保留原值）。
    expect(overview).toContain("syncIntervalMinutes: planDraft.syncIntervalMinutes");
    // 每个时间窗有可访问进度条、重置时间与文字状态，不能只靠颜色表达。
    expect(overview).toContain('role="progressbar"');
    expect(overview).toContain("aria-valuenow");
    expect(overview).toContain("数据可能过期");
    expect(overview).toContain("失败时保留最近成功用量");
    expect(overview).toContain("重置时间");
    // 订阅适配器：只读本机 CLI 凭据、不落盘，窗口标签覆盖 30 天/Code Review/Extra Usage。
    expect(overview).toContain("openai-subscription");
    expect(overview).toContain("anthropic-subscription");
    expect(overview).toContain("Codex CLI");
    expect(overview).toContain("Claude Code CLI");
    expect(overview).toContain("官方 CLI");
    expect(overview).toContain('"30d": "30 天窗口"');
    expect(overview).toContain('code_review: "Code Review"');
    expect(overview).toContain('extra_usage: "Usage Credits（超额额度）"');
    expect(providerMeta).toContain('planLabel: "OpenAI 订阅（ChatGPT/Codex）"');
    expect(providerMeta).toContain('planLabel: "Anthropic 订阅（Claude Max/Pro）"');
    // 国内价格仍走当前 USD/美元字段，但明确不换算；套餐月费进入目标价格策略。
    expect(overview).not.toContain("目录价格按供应商官方原始数值维护");
    expect(overview).toContain("套餐月费");
    expect(sharedTypes).toContain("planMonthlyFee?: number;");
    expect(types).toContain("candidateCount: number;");
    expect(types).toContain("processedCount: number;");
    expect(types).toContain("limited: boolean;");
  });

  test("目录刷新只加不减表格：面板只上报新增勾选，白名单全集由页面按目标真相拼接（2026-10-07 用户确认）", async () => {
    const review = await readFile(`${componentDir}/provider-catalog-review.tsx`, "utf8");
    const resources = await readFile(`${componentDir}/proxy-resources-tab.tsx`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    const css = await readFile(`${componentDir}/proxy-management.module.css`, "utf8");
    // 表格显著展示模型 ID；单模型按钮入口移除，统一勾选 + 批量「添加所选模型」。
    expect(review).not.toContain("onConfirmSingle");
    expect(review).not.toContain("仅更新此模型");
    expect(review).not.toContain("添加模型</button>");
    expect(resources).not.toContain("onApplySingleCatalogModel");
    expect(resources).not.toContain("onConfirmSingle");
    expect(page).not.toContain("applySingleCatalogModelToTarget");
    // 页面拼白名单全集（目标真相源），杜绝 diff 截断导致组件漏拼被服务端误删。
    expect(page).toContain("const selectedModelIds = [...new Set([...selectedTarget.supportedModels, ...addedModelIds])];");
    expect(page).not.toContain("mode: \"single\"");
    expect(page).not.toContain("refreshCatalogPricingForModels");
    expect(css).toContain(".catalogModelHeading code");
  });

  test("计费覆盖编辑器：闲时价格在长上下文档位之前置底，未改动时保存置灰", async () => {
    const resources = await readFile(`${componentDir}/proxy-resources-tab.tsx`, "utf8");
    const lc = resources.indexOf("长上下文档位（一般为空，不同上下文计价单位不同才需要填写）");
    const xs = resources.indexOf("闲时价格（非缓存输入 / 缓存输入 / 输出）");
    expect(lc).toBeGreaterThan(-1);
    expect(xs).toBeGreaterThan(-1);
    // 闲时价格块在长上下文档位块之前展开（长上下文档位始终处于编辑区最下面）。
    expect(xs).toBeLessThan(lc);
    expect(resources).not.toContain("长上下文档位（整请求换档）");
    expect(resources).toContain("overrideDirty");
    expect(resources).toContain("disabled={saving || !overrideDirty}");
  });

  test("账号/套餐表单引导文案整块红色强调（2026-09-05 用户确认）", async () => {
    const overview = await readFile(`${componentDir}/proxy-overview-tab.tsx`, "utf8");
    const css = await readFile(`${componentDir}/proxy-management.module.css`, "utf8");
    expect(overview).toContain("不设置也不影响网关转发，但会影响金额消耗准确性统计，强烈建议设置！");
    // 账号（按量）与套餐两条引导同语义修改。
    expect(overview.match(/不设置也不影响网关转发/g)?.length).toBe(2);
    expect(overview).toContain("formFooterWarning");
    expect(css).toContain(".formFooterWarning");
    expect(css).toContain("var(--danger");
  });

  test("账号/套餐表单的提示文案移到整行注释放置，不再撑开字段导致输入框错位", async () => {
    const overview = await readFile(`${componentDir}/proxy-overview-tab.tsx`, "utf8");
    const css = await readFile(`${componentDir}/proxy-management.module.css`, "utf8");
    // 提示不再挂在字段 label 内部（那会把该字段撑高、与同排其它 input 错位）。
    expect(overview).not.toContain("</select><small>官方预设优先使用 API Key");
    expect(overview).not.toContain("</select><small>不会回退第一条");
    expect(overview).not.toContain("<small>沿用当前美元字段展示");
    // 改为表单整行注释放置（grid-column 跨全列），且文案仍然保留。
    expect(overview).toContain("className={styles.formFooterHint}");
    expect(overview).not.toContain("目录价格按供应商官方原始数值维护");
    // 2026-09-05 用户确认：套餐卡 header 的凭据/币种说明句整体删除。
    expect(overview).not.toContain("套餐适配器显式选择同步凭据");
    expect(css).toContain(".formFooterHint");
    expect(css).toContain("grid-column: 1 / -1");
  });

  test("接入不等于设为默认：首次设置自动成为默认，非默认目标仍可配置", async () => {
    const agentTab = await readFile(`${componentDir}/proxy-agent-tab.tsx`, "utf8");
    const dialog = await readFile(`${componentDir}/connect-agent-dialog.tsx`, "utf8");
    const wizard = await readFile(`${componentDir}/proxy-onboarding-wizard.tsx`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    const proxyConfig = await readFile("src/proxy-config.ts", "utf8");
    // 已接入的 Agent 无论是否默认都渲染完整卡片（可配置默认模型/密钥），非默认时提示默认代理目标去向。
    expect(agentTab).toContain("默认供应商：");
    expect(agentTab).not.toContain("轻量卡片");
    // 接入弹窗：首次设置也必须显式勾选默认；已有默认则不改变。
    expect(dialog).toContain("接入不会改变默认");
    expect(dialog).toContain("仅建立接入绑定并保持待配置");
    // 向导：接入说明精简，只保留 Agent 选择和自动补齐规则。
    expect(wizard).toContain("只选择本次需要接入的 Agent");
    expect(wizard).not.toContain("设为该 Agent 默认代理供应商");
    expect(page).toContain("boundTargetIds: [selectedTarget.id]");
    expect(page).not.toContain("setAsDefault");
    expect(proxyConfig).toContain("const implicitDefaultTargetId");
  });

  test("侧栏仅保留供应商列表，顶部 Agent 入口只展示已接入且与选中目标无联动", async () => {
    const badges = await readFile(`${componentDir}/agent-entry-badges.tsx`, "utf8");
    const sidebar = await readFile(`${componentDir}/proxy-target-sidebar.tsx`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    // 顶部入口只按「有效接入」展示，与选中代理目标无联动；编辑按钮带 title 提示。
    expect(badges).toContain("AGENT_CATALOG.filter(entry => boundCompatibleTargetsForAgent(config, entry.id).length > 0)");
    expect(badges).not.toContain("isAgentConnected(config, entry.id)");
    expect(badges).not.toContain("targetSupportsAgent");
    expect(badges).toContain("编辑 ${agentLabel(entry.id)} 默认入口");
    // 侧栏不再有「各 Agent 默认入口」与底部新增按钮。
    expect(page).not.toContain("AgentEntryList");
    expect(sidebar).not.toContain("secondaryButtonFull");
    expect(page).not.toContain("onDisconnect=");
  });

  test("Agent 接入页只渲染已接入卡片，并按需展开与全屏查看受管文件", async () => {
    const agentTab = await readFile(`${componentDir}/proxy-agent-tab.tsx`, "utf8");
    const filePreview = await readFile(`${componentDir}/config-file-preview.tsx`, "utf8");
    const fileDialog = await readFile(`${componentDir}/config-file-dialog.tsx`, "utf8");
    const css = await readFile(`${componentDir}/proxy-management.module.css`, "utf8");
    // 支持但未接入的 Agent 只进入底部接入入口，不再渲染独立卡片。
    expect(agentTab).toContain("connected.map(entry =>");
    expect(agentTab).toContain("connection.boundTargetIds?.includes(target.id) || connection.defaultTargetId === target.id");
    expect(agentTab).not.toContain("supportedByTarget.map(entry => <AgentCard");
    expect(agentTab).toContain("尚未接入的 Agent：");
    // 文件内容默认折叠，摘要必须包含数量与受管方式。
    expect(agentTab).toContain("受管配置文件");
    expect(agentTab).toContain("cliFiles.length");
    expect(agentTab).not.toContain("agentCardSummaryV5");
    expect(agentTab).not.toContain("previewToggle");
    expect(agentTab).not.toContain("CatalogPreviewEditor");
    expect(filePreview).toContain("managementLabel(file)");
    expect(filePreview).toContain('const [open, setOpen] = useState(false)');
    expect(filePreview).toContain("/api/config-sync/file");
    expect(filePreview).toContain("Maximize2");
    expect(filePreview).toContain("ConfigFileDialog");
    expect(filePreview).toContain("useEffect");
    expect(filePreview).toContain("setPreview(null)");
    expect(filePreview).toContain("statusLabel(file)");
    expect(filePreview).toContain("当前供应商贡献");
    expect(filePreview).toContain("仅含 DeepAA 共享接管");
    expect(fileDialog).toContain("展开敏感值");
    expect(fileDialog).toContain('targetId, reveal: "1"');
    expect(filePreview).not.toContain("无当前供应商内容");
    expect(fileDialog).toContain('role="dialog"');
    expect(fileDialog).toContain("合并后内容");
    expect(fileDialog).toContain("同步前内容");
    expect(fileDialog).toContain("Escape");
    expect(fileDialog).toContain("sectionKindLabel");
    expect(fileDialog).toContain("returnFocusRef.current");
    expect(css).toContain(".agentCliFilesHeader");
    expect(css).toContain(".configFileManagement");
    expect(agentTab).toContain("agentDefaultsPanelV5");
    expect(css).not.toContain(".agentCardSummaryV5");
    expect(css).toContain(".agentDefaultsPanelV5");
    expect(css).toContain(".agentConnectionCard:hover");
    expect(css).toContain("#f2faf6");
    expect(css).toContain("background: #fcfdff");
    expect(css).toContain("background: #fbfdff");
    expect(css).toContain(".configFileDialog");
  });

  test("删除目标级联清理凭据与账号，左侧 Agent 列表加载全量凭据保持独立", async () => {
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    const presets = await readFile("src/lib/provider-presets.ts", "utf8");
    // 删除目标：先二次确认 → 清空凭据 → 删控制台账号（连同快照）→ 删目标。
    expect(page).toContain("/api/development-launch/credentials/purge");
    expect(page).toContain("confirmDialog({title: \"删除供应商\"");
    expect(page).toContain("供应商「${selectedTarget.name || selectedTarget.id}」已删除。");
    // 挂载时批量加载全部目标凭据（targets 批量接口一次拉齐），Agent 列表不随选中目标联动。
    expect(page).toContain("loadCredentialsBatch");
    expect(page).toContain("initialConfig.targets.map(target => target.id)");
    expect(page).toContain("不能随选中供应商联动");
    // 预设：国产厂商带 Anthropic 协议端点。
    expect(presets).toContain("https://api.deepseek.com/anthropic");
    expect(presets).toContain("https://open.bigmodel.cn/api/anthropic");
    expect(presets).toContain("https://api.moonshot.cn/anthropic");
    expect(presets).toContain("https://api.minimax.cn/anthropic");
  });

  test("密钥归属勾掉默认密钥需确认并跟随取消，顶部入口带开发快捷入口，预设双协议一次填充", async () => {
    const resources = await readFile(`${componentDir}/proxy-resources-tab.tsx`, "utf8");
    const badges = await readFile(`${componentDir}/agent-entry-badges.tsx`, "utf8");
    const dialog = await readFile(`${componentDir}/agent-default-entry-dialog.tsx`, "utf8");
    const basic = await readFile(`${componentDir}/proxy-basic-tab.tsx`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    // 密钥：勾掉某 Agent 归属且该密钥是其默认密钥时，确认后默认密钥跟随取消。
    expect(resources).toContain("默认密钥会自动切换为其他适用密钥（无则取消），确认执行吗");
    expect(resources).not.toContain("默认密钥将自动更新为");
    // 顶部入口弹窗带「在 X 中开发」快捷入口。
    expect(dialog).toContain("SquareTerminal");
    expect(dialog).toContain("在 {label} 中开发");
    expect(dialog).toContain("onLaunch");
    expect(page).toContain("setDevelopmentTarget");
    expect(page).toContain("<DevelopmentLaunchDialog");
    expect(page).not.toContain("AgentDefaultEntryDialog");
    // 预设：双协议一次提交，选中后保持显示。
    expect(basic).toContain("commitUrls");
    expect(basic).toContain("applyPreset");
    expect(basic).toContain("setSelectedPresetId(presetId)");
    // 预设切换：按新预设全量替换（未声明的协议置空）。
    expect(basic).toContain("const openaiUrl = preset.openaiUrl || \"\"");
    expect(basic).not.toContain("event.currentTarget.value = \"\"");
  });

  test("停用代理需二次确认并自动切换默认代理，模型/密钥归属调整带默认确认", async () => {
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    const resources = await readFile(`${componentDir}/proxy-resources-tab.tsx`, "utf8");
    // 停用二次确认：提示受影响 Agent 与新默认代理去向（无可用代理则警告待配置）。
    expect(page).toContain("确认停用供应商");
    expect(page).toContain("停用后将自动切换为");
    expect(page).toContain("无其他可用供应商，将变为待配置状态");
    expect(page).toContain("confirmDialog({title: \"停用供应商\"");
    // 模型归属：去掉归属需确认并自动切换/警告。2026-10-11 修复：默认模型记录按目标
    // 各自保存（非默认供应商同样持有），错误 skip 已删；兜底与服务端修复器同源。
    expect(resources).not.toContain("config.agentConnections[agent]?.defaultTargetId !== target.id");
    expect(resources).toContain("eligibleDefaultModelForAgent");
    expect(resources).toContain("默认模型将自动更新为");
    expect(resources).toContain("将没有可切换的合格模型");
    expect(resources).toContain("默认密钥会自动切换为其他适用密钥（无则取消），确认执行吗");
  });

  test("自定义模型发现使用价格模型列表并隐藏内部 priceEntryId", async () => {
    const resources = await readFile(`${componentDir}/proxy-resources-tab.tsx`, "utf8");
    const wizard = await readFile(`${componentDir}/proxy-onboarding-wizard.tsx`, "utf8");
    const discoveryTable = await readFile(`${componentDir}/model-discovery-table.tsx`, "utf8");
    expect(resources).toContain("ModelDiscoveryTable");
    expect(wizard).toContain("ModelDiscoveryTable");
    expect(wizard).toContain("模型族");
    for (const label of ["模型 ID", "非缓存输入 /M", "缓存输入 /M", "输出 /M", "上下文窗口", "最大输出 Token"]) {
      expect(discoveryTable).toContain(label);
    }
    expect(discoveryTable).not.toContain("<th>供应商</th>");
    expect(discoveryTable).toContain("disabled");
    expect(discoveryTable).not.toContain("{item.priceEntryId}");
    // 探测结果默认不勾选任何模型（2026-10-07 用户确认，与向导口径一致）：由用户自行勾选；
    // 已在白名单的模型由表格强制勾选置灰展示，本密钥未返回的既有模型服务端自动保留。
    expect(resources).toContain("setSelectedDiscoveredModels([]);");
    expect(resources).not.toContain("...(result.matched || []).map(item => item.modelId)");
    expect(wizard).toContain("setSelectedDiscoveredModels([])");
  });

  test("密钥与模型展示按目标映射锁定供应商，补查价格条目不跨供应商猜名", async () => {
    const resources = await readFile(`${componentDir}/proxy-resources-tab.tsx`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    // 展示层改用“priceEntryId → 供应商 + 模型名”的锁定解析，不再全局按模型名取第一条。
    expect(resources).toContain("resolveTargetModelPriceEntry(pricingModels, modelId, mapping)");
    expect(resources).not.toContain("pricingModels.find(item => runtimeModelIdOf(item)");
    // 页面补查缺失价格条目时优先按 priceEntryId 精确拉取，命中同样按供应商锁定。
    expect(page).toContain("const search = mapping?.priceEntryId || modelId");
    expect(page).toContain("resolveTargetModelPriceEntry(page.items, modelId, mapping)");
  });

  test("删除控制台账号物理删除快照与同步记录，未知错误透出原始原因", async () => {
    const store = await readFile("src/lib/sync-engine/store.ts", "utf8");
    const security = await readFile("src/lib/development-launch/security.ts", "utf8");
    // 删除账号时物理删除 balance_snapshots / credential_rate_snapshots / sync_runs（按 target_id），
    // 账号信息严格跟随代理目标，不留可被重建同名目标复活的残留快照。
    expect(store).toContain("DELETE FROM balance_snapshots WHERE target_id = ?");
    expect(store).toContain("DELETE FROM credential_rate_snapshots WHERE target_id = ?");
    expect(store).toContain("DELETE FROM sync_runs WHERE target_id = ?");
    expect(store).toContain("DELETE FROM console_accounts WHERE target_id = ?");
    // 未知错误响应带上原始错误信息，不再只显示笼统的「本地开发环境操作失败」。
    expect(security).toContain("操作失败：${detail}");
  });

  test("供应商管理完整移除 CLI 导入链路且保留公共配置能力", async () => {
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    expect(page).not.toContain("ConfigImportDialog");
    expect(page).not.toContain("configImportDialogOpen");
    expect(page).not.toContain("handleConfigImported");
    expect(page).not.toContain("从 Codex / Claude Code 导入");
    expect(existsSync("src/components/proxy-management/config-import-dialog.tsx")).toBe(false);
    expect(existsSync("src/app/api/config-import/route.ts")).toBe(false);
    expect(existsSync("src/lib/config-import")).toBe(false);
    expect(existsSync("src/lib/config-sync")).toBe(true);
    expect(existsSync("src/app/api/config-sync/route.ts")).toBe(true);
    expect(existsSync("src/lib/development-launch/service.ts")).toBe(true);
  });

  test("目标侧栏平铺展示所有代理目标，不再按供应商族分组", async () => {
    const sidebar = await readFile(`${componentDir}/proxy-target-sidebar.tsx`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    const css = await readFile(`${componentDir}/proxy-management.module.css`, "utf8");
    expect(sidebar).not.toContain("presetFamilyLabel");
    expect(sidebar).not.toContain("targetGroupTitle");
    expect(sidebar).not.toContain("inferTargetChannelMetadata");
    expect(sidebar).toContain("visible.map");
    expect(sidebar).toContain("targetList");
    expect(css).not.toContain(".targetGroupTitle");
    expect(page).toContain("channelBadge");
    expect(css).toContain(".channelBadge");
  });

  test("新建目标官方预设下拉支持搜索、供应商族色块分组并带通道标识", async () => {
    const basic = await readFile(`${componentDir}/proxy-basic-tab.tsx`, "utf8");
    const family = await readFile("src/lib/preset-family.ts", "utf8");
    const css = await readFile(`${componentDir}/proxy-management.module.css`, "utf8");
    expect(basic).toContain("groupedPresets");
    expect(basic).toContain("presetPicker");
    expect(basic).toContain("presetPickerSearch");
    expect(basic).toContain("presetPickerGroup");
    expect(basic).toContain("presetPickerOption");
    expect(basic).toContain("presetSearch");
    expect(basic).toContain('aria-expanded');
    expect(basic).toContain('Escape');
    expect(basic).toContain("channelLabel");
    expect(family).toContain("PRESET_FAMILY_LABELS");
    expect(css).toContain(".presetPickerPanel");
    expect(css).toContain(".presetPickerGroup:hover");
    expect(css).toContain(".presetPickerOption");
    expect(css).toContain(".channelLabel");
  });

  test("官方预设下拉面板紧贴触发器，行级 hover 改为无边框深灰高亮", async () => {
    const basic = await readFile(`${componentDir}/proxy-basic-tab.tsx`, "utf8");
    const css = await readFile(`${componentDir}/proxy-management.module.css`, "utf8");
    // 面板定位到只包裹触发按钮的容器，而不是包含标签与提示文字的整块字段。
    expect(basic).toContain("presetPickerControl");
    expect(css).toContain(".presetPickerControl");
    expect(css).toContain("position: relative");
    // 行级 hover/选中不再使用绿色背景 + 四圈线框，改为无边框的深灰高亮。
    expect(css).not.toContain(".presetPickerOption:hover,\n.presetPickerOptionActive {\n  border-color: var(--pm-accent);");
    expect(css).toContain(".presetPickerOption:hover");
    expect(css).toContain("background: var(--surface-3)");
    // 供应商族整块 hover 保持淡蓝，与行级灰色区分。
    expect(css).toContain(".presetPickerGroup:hover");
    expect(css).toContain("background: var(--pine-50)");
  });

  test("官方预设下拉搜索框为单一紧凑输入框，不再出现内部叠加边框", async () => {
    const css = await readFile(`${componentDir}/proxy-management.module.css`, "utf8");
    expect(css).toContain(".presetPickerSearchWrap");
    expect(css).toContain("height: 40px");
    expect(css).toContain(".presetPickerSearch");
    // 扁平化规则必须用双类选择器压过通用 .field input（0,1,1），
    // 并显式覆盖 min-height / border-radius，否则内层会再次长出边框与溢出。
    expect(css).toContain(".presetPickerSearchWrap .presetPickerSearch {");
    const flattenBlock = css.slice(
      css.indexOf(".presetPickerSearchWrap .presetPickerSearch {"),
      css.indexOf(".presetPickerSearch::placeholder")
    );
    expect(flattenBlock).toContain("min-height: 0");
    expect(flattenBlock).toContain("border-radius: 0");
    expect(flattenBlock).toContain("border: 0");
    expect(flattenBlock).toContain("padding: 0");
    expect(flattenBlock).toContain("background: transparent");
    expect(flattenBlock).toContain("appearance: none");
    expect(flattenBlock).toContain("box-shadow: none");
    // 不允许存在特异性不足的单类扁平化形态，防止回退到被 .field input 反杀的写法。
    expect(css).not.toMatch(/^\.presetPickerSearch \{/m);
  });

  test("向导系统密钥名称跟随代理目标名（密钥N 递增命名），不写死占位", async () => {
    const wizard = await readFile(`${componentDir}/proxy-onboarding-wizard.tsx`, "utf8");
    expect(wizard).toContain("nextCredentialLabel(target.name || target.id || \"供应商\"");
    // 密钥与模型页签新增密钥同样使用递增默认名
    const resources = await readFile(`${componentDir}/proxy-resources-tab.tsx`, "utf8");
    expect(resources).toContain("nextCredentialLabel(target.name, targetCredentials.map(item => item.label))");
  });

  test("套餐用量进度条定义成功/警告/危险三档背景色变量", async () => {
    const css = await readFile(`${componentDir}/proxy-management.module.css`, "utf8");
    expect(css).toContain("--pm-success: var(--ok);");
    expect(css).toContain("--pm-warning: var(--warning);");
  });

  test("密钥同步区块仅对非官方预设展示，官方预设隐藏该模块", async () => {
    const overview = await readFile(`${componentDir}/proxy-overview-tab.tsx`, "utf8");
    expect(overview).toContain("{!targetPreset ? <section className={styles.credentialSyncSection}>");
    // 「密钥同步」从标题降级为与账号信息同字号的说明文案，不再单独使用小标题。
    expect(overview).toContain("分钟自动同步供应商站对应密钥分组的价格倍率信息");
    expect(overview).toContain("密钥名称和内容请移步至「密钥与模型」维护");
    expect(overview).not.toContain("<h4>密钥同步</h4>");
    expect(overview).toContain("credentialSyncNote");
  });

  test("密钥与模型归属与目标实际支持联动：失去支持即级联取消，适用 Agent 确认修改即保存", async () => {
    const resources = await readFile(`${componentDir}/proxy-resources-tab.tsx`, "utf8");
    const catalog = await readFile(`${componentDir}/agent-catalog.ts`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    // 归属选项只允许「目标真正能服务」的 Agent（协议 + 归属模型 + 归属密钥）。
    expect(resources).toContain("servedAgentsForTarget(target, credentials)");
    expect(resources).toContain("credentialScopeOptions");
    expect(resources).toContain("if (credential.targetId !== nextTarget.id) continue;");
    expect(resources).toContain("props.onUnbindAgents(dropped)");
    expect(resources).toContain("当前供应商唯一的密钥");
    expect(catalog).toContain("export function servedAgentsForTarget");
    expect(catalog).toContain("export function buildAgentDropPatch");
    // 密钥归属「确认修改」即时保存：只提交归属，不携带名称/内容/倍率。
    expect(resources).toContain("立即独立保存适用变更");
    expect(resources).toContain("await onUpdate({credentialId: item.id, agentScope: nextScope})");
    // 模型列表在模型 ID 后展示供应商支持协议（wire API 能力说明）。
    expect(resources).toContain("供应商支持协议");
    expect(resources).toContain("resolveTargetModelWireApis(target, modelId)");
    // 计费覆盖支持修改范围选择：默认写入价格中心唯一条目（全局），可切「仅当前供应商」。
    expect(resources).toContain("pricingScope");
    expect(resources).toContain("应用于价格中心");
    expect(resources).toContain("仅应用于当前供应商");
    expect(resources).toContain("单独定价");
    // 失去支持时从模型归属、密钥归属与默认链联动取消。
    expect(resources).toContain("cascadeSupportChange");
    expect(resources).toContain("已联动取消不再支持的 Agent");
    expect(resources).toContain("onUpdateCredentialScope");
    // 密钥/模型标题「默认」徽章只对目标实际支持且归属仍生效的 Agent 展示。
    expect(resources).toContain("servedSet.has(agent)");
    expect(page).toContain("onUpdateCredentialScope");
  });

  test("套餐窗口按数量自适应等分，重置时间为天/小时/分钟组合并显式体现用量百分比", async () => {
    const overview = await readFile(`${componentDir}/proxy-overview-tab.tsx`, "utf8");
    const css = await readFile(`${componentDir}/proxy-management.module.css`, "utf8");
    expect(overview).toContain("quotaGrid");
    expect(overview).toContain("formatResetRelative");
    expect(overview).toContain("分钟后");
    // 小时以上用「X小时Y分钟后」组合（秒钟不计、不足 1 分钟不计数），不再出现小数小时。
    expect(overview).toContain("小时${minuteSuffix}");
    expect(overview).not.toMatch(/toFixed\(2\)\}小时后/);
    expect(overview).toContain("quotaPercent");
    // 套餐用量卡余量主口径（2026-10-07 用户确认，与侧栏/仪表盘同链）：主数字与进度条长度=剩余占比，
    // 颜色档与级别文案仍按已用占比判定。
    expect(overview).toContain("planQuotaRemainingPercent");
    expect(overview).toContain("剩 ${remainingPercent.toFixed(1)}%");
    expect(overview).toContain("供应商仅返回百分比");
    expect(overview).toContain("已用");
    expect(overview).toContain("剩余");
    expect(overview).toContain("共");
    expect(overview).toContain("重置时间：");
    // 窗口数量自适应：无月套餐的两个窗口也等分整行。
    expect(css).toContain("grid-template-columns: repeat(auto-fit, minmax(0, 1fr))");
  });

  test("供应商页头文案与账号引导间距、官方预设禁用置灰", async () => {
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    const css = await readFile(`${componentDir}/proxy-management.module.css`, "utf8");
    expect(page).toContain("支持各大官方预设供应商及各大三方自定义中转站。");
    expect(page).not.toContain("先定义可复用的供应商目标");
    // 账号信息高亮说明与上方站点类型表单之间留出间距并加分隔。
    expect(css).toContain("margin: 18px 0 2px;");
    expect(css).toContain("border-top: 1px solid var(--pm-border);");
    // 基础信息页签官方预设选择框禁用时整体置灰。
    expect(css).toContain(".presetPickerTrigger:disabled");
    expect(css).toContain("background: var(--surface-3);");
  });

  test("向导底部动作收纳到右侧动作组，模型步骤不再显示探测等待提示", async () => {
    const wizard = await readFile(`${componentDir}/proxy-onboarding-wizard.tsx`, "utf8");
    // 2026-09-04 用户确认：删除“系统完成探测后，请确认模型或从价格中心选择”提示文案。
    expect(wizard).not.toContain("系统完成探测后，请确认模型或从价格中心选择");
    expect(wizard).not.toContain("stickyHint");
    // 完成配置等主动作与辅助动作统一收进右侧 wizardFooterActions 动作组，与左侧“稍后继续”对称。
    expect(wizard).toContain("wizardFooterActions");
    expect(wizard).toContain("启用供应商并完成配置");
    expect(wizard).toContain("已有兼容模型，直接接入");
    expect(wizard).toContain("确认模型并继续");
    const css = await readFile(`${componentDir}/proxy-management.module.css`, "utf8");
    expect(css).toContain(".wizardFooterActions");
    expect(css).toMatch(/\.wizardFooterActions\s*\{[^}]*margin-left:\s*auto/s);
  });

  test("新建预设不再显示刷新按钮；刷新/探测入口统一放到密钥与模型页签", async () => {
    const basic = await readFile(`${componentDir}/proxy-basic-tab.tsx`, "utf8");
    const resources = await readFile(`${componentDir}/proxy-resources-tab.tsx`, "utf8");
    expect(basic).not.toContain("刷新预设模型");
    expect(resources).toContain("刷新预设模型");
    expect(resources).toContain("onRefreshProviderCatalog");
    expect(resources).toContain("ProviderCatalogReview");
    // 自定义目标探测模型时默认选中一条目标密钥，不再要求手动选择。
    expect(resources).toContain("setDiscoveryCredentialId(preferred)");
  });

  test("新建草稿可切换到其它目标并可切回草稿，侧栏以 createdAt 区分身份", async () => {
    const sidebar = await readFile(`${componentDir}/proxy-target-sidebar.tsx`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    expect(sidebar).toContain("draftCreatedAt");
    expect(sidebar).toContain("onSelect(target.id, target.createdAt)");
    expect(page).toContain("function selectTarget(targetId: string, createdAt?: string)");
    expect(page).toContain("clickedIsDraft");
  });

  test("概览页预设反查优先目标 presetId，订阅目标不会误认成按量预设", async () => {
    const overview = await readFile(`${componentDir}/proxy-overview-tab.tsx`, "utf8");
    expect(overview).toContain("target.presetId");
    expect(overview).toContain("SUBSCRIPTION_OAUTH");
  });

  test("供应商列表：去掉「已配置/待配置」文案，圆点承载状态（2026-09-18 用户确认）", async () => {
    const sidebar = await readFile(`${componentDir}/proxy-target-sidebar.tsx`, "utf8");
    // 状态文案必须从可见文本里消失（只作为 title/aria-label 保留完整语义）。
    expect(sidebar).not.toContain('<span className={styles.targetState}>');
    expect(sidebar).not.toContain('"已配置" : "待配置"}</span>');
    expect(sidebar).toContain("const stateLabel = !target.enabled ? \"已停用\" : ready ? \"已配置\" : \"待配置\"");
    expect(sidebar).toContain("aria-label={rowTitle}");
    // 三档圆点仍在：绿=已配置、橙=待配置、灰=已停用。
    expect(sidebar).toContain("styles.statusReady");
    expect(sidebar).toContain("styles.statusPending");
    expect(sidebar).toContain("styles.statusOff");
  });

  test("供应商列表：账号类型徽标（量/套/订）与余额、套餐窗口用量", async () => {
    const sidebar = await readFile(`${componentDir}/proxy-target-sidebar.tsx`, "utf8");
    const css = await readFile(`${componentDir}/proxy-management.module.css`, "utf8");
    expect(sidebar).toContain("pay_as_you_go: {short: \"量\"");
    expect(sidebar).toContain('plan: {short: "套"');
    expect(sidebar).toContain('subscription: {short: "订"');
    expect(sidebar).toContain("TargetUsageLine");
    // 余额（按量）与套餐窗口用量共用一份展示口径，禁止就地手写第二份。
    expect(sidebar).toContain("formatPlanQuotaHeadline");
    expect(sidebar).toContain("formatPlanQuotaAmount");
    expect(sidebar).not.toContain("QUOTA_WINDOW_LABELS");
    expect(css).toContain(".channelTag");
    expect(css).toContain(".targetUsage");
  });

  test("供应商列表：「没设置」按通道给不同文案，且概览未返回前不出倍率标", async () => {
    const sidebar = await readFile(`${componentDir}/proxy-target-sidebar.tsx`, "utf8");
    const badgeLib = await readFile("src/lib/sync-engine/target-health-badge.ts", "utf8");
    const css = await readFile(`${componentDir}/proxy-management.module.css`, "utf8");
    // 按量 → 账号未设置；套餐/订阅 → 套餐（订阅）未设置（统一来自共享模块）。
    expect(sidebar).toContain('usageFallbackLabel("account")');
    expect(sidebar).toContain('usageFallbackLabel("plan")');
    // 概览未返回时保持沉默：不出健康标识、用量行显示中性占位。
    // factsLoaded 的判定收敛在共享适配器 badgeInputFromOverview 里，侧栏不再自带映射。
    expect(badgeLib).toContain("factsLoaded: false");
    expect(badgeLib).toContain("factsLoaded: true");
    expect(sidebar).toContain("读取中…");
    // 同步配置没补上时，列表标记直接说「账号未设置 / 套餐（订阅）未设置」，
    // 而不是抽象的「倍率未校验」（2026-09-18 用户反馈 1yuanapi）。
    expect(badgeLib).toContain("includeConfigurationGaps: true");
    expect(badgeLib).toContain("resolveOfficialPresetForTarget(target)");
    expect(badgeLib).toContain("resolvePlanProviderForTarget(target)");
    // 1.3：余额/套餐用量行整体下移 3px。
    const usage = css.slice(css.indexOf(".targetUsage,\n.targetUsageMuted {"), css.indexOf(".targetUsage {"));
    expect(usage).toContain("margin-top: 3px;");
  });

  test("新建向导模型发现：已选列表标注价格中心供应商", async () => {
    const wizard = await readFile(`${componentDir}/proxy-onboarding-wizard.tsx`, "utf8");
    const css = await readFile(`${componentDir}/proxy-management.module.css`, "utf8");
    // 2.1：无意义的后半句（含分号）已删除。
    expect(wizard).not.toContain("本密钥未返回的既有模型会在确认时自动保留");
    expect(wizard).toContain("默认不勾选，请至少选择一个预期要使用的模型后才能继续。</p>");
    // 2.2：模型 + 供应商才唯一，列表必须带供应商后缀。
    expect(wizard).toContain("catalogVendorFor");
    expect(wizard).toContain("styles.wizardPickVendor");
    expect(css).toContain(".wizardPickVendor");
  });

  test("供应商列表：概览经有界只读接口一次性读取，不做逐目标重响应", async () => {
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    const route = await readFile("src/app/api/proxy-sync/overview/route.ts", "utf8");
    const service = await readFile("src/lib/sync-engine/service.ts", "utf8");
    expect(page).toContain("loadSyncOverview");
    expect(page).toContain("/api/proxy-sync/overview?targets=");
    expect(page).toContain("overviewByTarget={syncOverviewByTarget}");
    expect(route).toContain("getSyncService()).overview(targetIds)");
    // 有界证据：目标数与时间窗数都有硬上限。
    expect(service).toContain("MAX_OVERVIEW_TARGETS");
    expect(service).toContain("OVERVIEW_PLAN_WINDOW_LIMIT");
  });

  test("倍率提醒：供应商列表与密钥同步列表都出标，且不含拆链/内部保证文案", async () => {
    const sidebar = await readFile(`${componentDir}/proxy-target-sidebar.tsx`, "utf8");
    const overview = await readFile(`${componentDir}/proxy-overview-tab.tsx`, "utf8");
    const page = await readFile("src/components/proxy-management-page.tsx", "utf8");
    const service = await readFile("src/lib/sync-engine/service.ts", "utf8");
    const css = await readFile(`${componentDir}/proxy-management.module.css`, "utf8");
    const badgeCss = await readFile(`${componentDir}/target-health-badge.module.css`, "utf8");
    // 侧栏健康标识：判定与渲染统一走公共模块/公共组件，不允许就地另写一份。
    expect(sidebar).toContain("resolveTargetBadge");
    expect(sidebar).toContain("badgeInputFromOverview");
    expect(sidebar).toContain("<TargetHealthBadge badge={badge} />");
    expect(sidebar).not.toContain("resolveRateWarning(");
    // 公共徽标组件自带 severe（红）样式，供侧栏与仪表盘共用。
    expect(badgeCss).toContain(".healthBadge");
    expect(badgeCss).toContain(".healthBadgeSevere");
    expect(overview).toContain("resolveRateWarning");
    expect(overview).toContain("rateWarningTitle");
    expect(css).toContain(".rateWarningBadgeSevere");
    // 「本系统不会因此改动密钥、模型或 Agent 关联」对用户没有价值，全部下线。
    for (const source of [sidebar, overview, page, service]) {
      expect(source).not.toContain("不会因此改动");
    }
    // 破坏性级联必须彻底消失。
    expect(service).not.toContain("cascadeCredentialsWithoutRate");
    expect(page).not.toContain("cascadeNotes");
    expect(page).not.toContain("级联调整");
    expect(page).toContain("rateSyncWarnings");
  });
});
