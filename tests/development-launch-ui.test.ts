import { describe, expect, test } from "vitest";
import { readFile } from "fs/promises";

describe("development launch UI source", () => {
  test("proxy management page uses per-target save without global save flow", async () => {
    const source = await readFile(
      new URL("../src/components/proxy-management-page.tsx", import.meta.url),
      "utf-8",
    );

    expect(source).toContain("saveSelectedTarget");
    expect(source).toContain("ProxyBasicTab");
    expect(source).not.toContain("配置已保存，代理已应用");
    expect(source).not.toContain("新的代理请求会立即使用此设置");
  });

  test("uses one protocol-specific launch dialog instead of legacy config writers", async () => {
    const proxySettings = await readFile(
      new URL("../src/components/proxy-management-page.tsx", import.meta.url),
      "utf-8",
    );
    const launchDialog = await readFile(
      new URL("../src/components/development-launch-dialog.tsx", import.meta.url),
      "utf-8",
    );

    expect(proxySettings).toContain("DevelopmentLaunchDialog");
    expect(launchDialog).toContain("在 ${registryAgentLabel(cli)} 中开发");
    expect(launchDialog).toContain("registryAgentLabel");
    expect(proxySettings).not.toContain("一键应用到本地配置");
    expect(proxySettings).not.toContain("本地配置检测");
  });

  test("contains labeled required fields, advanced disclosure, and accessible dialog controls", async () => {
    const source = await readFile(
      new URL("../src/components/development-launch-dialog.tsx", import.meta.url),
      "utf-8",
    );

    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain("项目目录");
    expect(source).toContain("密钥");
    expect(source).toContain("模型");
    expect(source).toContain("终端");
    expect(source).toContain("高级设置");
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain("请选择该供应商支持的模型");
  });

  test("keeps credential secrets out of URL parameters and clears the input after saving", async () => {
    const source = await readFile(
      new URL("../src/components/development-launch-dialog.tsx", import.meta.url),
      "utf-8",
    );

    expect(source).not.toContain('searchParams.set("secret"');
    const resources = await readFile(
      new URL("../src/components/proxy-management/proxy-resources-tab.tsx", import.meta.url),
      "utf-8",
    );
    expect(resources).toContain('setCredentialDraft({label: "", secret: "", rate: "1", scope: []})');
    expect(resources).toContain('type="password"');
  });

  test("blocks launch without an operating-system credential store", async () => {
    const launchDialog = await readFile(
      new URL("../src/components/development-launch-dialog.tsx", import.meta.url),
      "utf-8",
    );
    const resources = await readFile(
      new URL("../src/components/proxy-management/proxy-resources-tab.tsx", import.meta.url),
      "utf-8",
    );

    // 2026-09-18 用户确认：选目录只重跑预检，不再重置用户在弹窗内的默认项。
    expect(launchDialog).toContain('runPreflight(selection.path, selection.nonce, false)');
    expect(launchDialog).toContain("if (resetModel || (!modelModified && !modelUserPickedRef.current))");
    expect(launchDialog).toContain("!capabilities?.credentialStoreAvailable");
    expect(launchDialog).toContain("系统凭据库不可用");
    expect(launchDialog).toContain("warning.sourcePath");
    expect(resources).toContain("密钥指纹 {formatCredentialFingerprint(item.fingerprintSuffix)}");
    expect(launchDialog).toContain('event.key === "Tab"');
    expect(launchDialog).toContain("previousFocusRef");
    expect(launchDialog).toContain("credentialStoreAvailable");
    expect(launchDialog).toContain("系统凭据库不可用");
  });

  test("能力检测返回的 nonce 沿首次与历史目录递归预检传递", async () => {
    const source = await readFile(
      new URL("../src/components/development-launch-dialog.tsx", import.meta.url),
      "utf-8",
    );

    expect(source).toContain('return runPreflight("", loaded.nonce)');
    expect(source).toContain("runPreflight(body.lastProjectDir, body.nonce, resetModel)");
  });

  test("重新选择项目目录只重跑预检，不清空用户已编辑的高级设置", async () => {
    const source = await readFile(
      new URL("../src/components/development-launch-dialog.tsx", import.meta.url),
      "utf-8",
    );
    const chooseDirectoryStart = source.indexOf("async function chooseProjectDirectory()");
    const chooseDirectoryEnd = source.indexOf("\n  async function runPreflight(", chooseDirectoryStart);
    expect(chooseDirectoryStart).toBeGreaterThan(-1);
    expect(chooseDirectoryEnd).toBeGreaterThan(chooseDirectoryStart);
    const chooseDirectoryBody = source.slice(chooseDirectoryStart, chooseDirectoryEnd);
    expect(chooseDirectoryBody).not.toContain("setAdvanced({})");
    expect(chooseDirectoryBody).not.toContain("advancedDirtyRef.current = new Set()");
    expect(source).toContain("advancedDirtyRef.current.has(\"modelContextWindow\")");
    expect(source).toContain("advancedDirtyRef.current.has(\"modelAutoCompactTokenLimit\")");
  });

  test("开发弹窗使用目标支持的模型下拉，并暴露终端与 Codex 客户端选项", async () => {
    const launchDialog = await readFile(
      new URL("../src/components/development-launch-dialog.tsx", import.meta.url),
      "utf-8",
    );
    const proxySettings = await readFile(
      new URL("../src/components/proxy-management-page.tsx", import.meta.url),
      "utf-8",
    );

    expect(launchDialog).toContain("agentCompatibleModelsForTarget");
    expect(launchDialog).toContain("selectedModel");
    expect(launchDialog).toContain("Codex 客户端");
    expect(launchDialog).toContain("codex-client");
    expect(launchDialog).not.toContain("modelSelection.vendor");
    expect(launchDialog).not.toContain("expectedVendor");
  });

  test("五类 Agent 即使只有一个已接入供应商也统一显示默认供应商字段", async () => {
    const source = await readFile(
      new URL("../src/components/development-launch-dialog.tsx", import.meta.url),
      "utf-8",
    );
    expect(source).toContain("targetOptions && targetOptions.filter(item => item.enabled !== false).length > 0");
    expect(source).toContain("aria-label=\"选择该 Agent 的默认供应商\"");
    expect(source).not.toContain("length > 1 ? (");
  });

  test("模型选择直接来自代理目标支持的模型，不再依赖供应商价格目录", async () => {
    const source = await readFile(
      new URL("../src/components/development-launch-dialog.tsx", import.meta.url),
      "utf-8",
    );

    expect(source).toContain("const modelOptions = compatibleModels.map");
    expect(source).toContain("请选择该供应商支持的模型");
    expect(source).not.toContain("modelCatalog");
    expect(source).not.toContain("pricingVendor");
  });

  test("原生 Session ID 每次打开默认留空且只在用户显式填写后恢复", async () => {
    const source = await readFile(
      new URL("../src/components/development-launch-dialog.tsx", import.meta.url),
      "utf-8",
    );
    const advancedSettingsIndex = source.indexOf("development-advanced-grid");
    const sessionFieldIndex = source.indexOf("原生会话 Session ID");

    expect(source).toContain('const [resumeSessionId, setResumeSessionId] = useState("")');
    expect(source).toContain('const [resumeSessionTouched, setResumeSessionTouched] = useState(false)');
    expect(source).toContain("placeholder={cli === \"opencode\"");
    expect(source).toContain("粘贴 ses_ 开头的 Session ID 可继续");
    expect(source).toContain('autoComplete="off"');
    // 弹窗每次重新挂载（关闭即卸载），默认值由 useState("") 保证；
    // 选项目目录不再连带清空用户刚粘贴的会话 ID（2026-09-18 用户确认）。
    expect(source).toContain("onChange={event => setResumeSessionId(event.currentTarget.value)}");
    expect(source).not.toContain("localStorage");
    expect(source).toContain("resumeSessionId: normalizedResumeSessionId");
    expect(source).toContain("resumeSessionIdInvalid");
    expect(source).toContain('aria-invalid={resumeSessionTouched && resumeSessionIdInvalid}');
    expect(source).not.toContain("localStorage");
    expect(sessionFieldIndex).toBeGreaterThan(advancedSettingsIndex);
  });

  test("项目目录字段位于启动方式之后，Codex 客户端模式隐藏项目目录；Profile 与审批策略已移除", async () => {
    const source = await readFile(
      new URL("../src/components/development-launch-dialog.tsx", import.meta.url),
      "utf-8",
    );
    // 2026-10-05：终端字段统一更名为「启动方式」（承载客户端/CLI 形态选择）。
    const terminalIndex = source.indexOf('label>启动方式 <span className="required-mark">*</span>');
    const projectDirIndex = source.indexOf("development-project-dir");
    const isCodexClientModeIndex = source.indexOf("isCodexClientMode");

    expect(terminalIndex).toBeGreaterThan(-1);
    expect(projectDirIndex).toBeGreaterThan(terminalIndex);
    // Profile 与审批策略字段已按产品决策移除：源码不再出现对应输入。
    expect(source).not.toContain('label="Profile"');
    expect(source).not.toContain("approvalPolicy");
    // 枚举一律下拉，不再提供自由文本。
    expect(source).toContain("DevelopmentSelect");
    expect(source).toContain("CODEX_SANDBOX_MODES");
    expect(source).toContain("CLAUDE_PERMISSION_MODES");
    // 高级设置默认值来自模型目录，且切换模型时重填。
    expect(source).toContain("modelDefaults");
    expect(source).toContain("applyModelDefaults");
    // dsh/zcode 高级设置默认展开；zcode/dsh 不再要求项目目录（zcode 工作区为选填）。
    expect(source).toContain("requiresProjectDir");
    expect(source).toContain("工作区目录（选填）");
    expect(source).not.toContain('!isCodexClientMode && !isZcodeApp && !projectDir');
    // 项目目录要求与形态无关（服务端终端路径始终强制目录）；官方直连只豁免模型。
    expect(source).toContain("(!isCodexClientMode && requiresProjectDir && !projectDir)");
    // Codex 客户端模式项目目录选填且不隐藏（codex app [PATH] 打开该工作区）。
    expect(source).toContain("项目目录{isCodexClientMode ? \"（选填）\" : \"\"}");
    expect(source).toContain("留空则打开 Codex 客户端默认工作区");
    // 2026-10-09：官方直连形态不提交偏好（空对象会清除已落库偏好），网关形态仍完整状态提交。
    expect(source).toContain("usesLaunchPreferences && !officialLaunch ? buildLaunchPreferences(target.id) ?? {} : undefined");
    // 参数分流（2026-10-02）：codex 能力类参数走 launchPreferences（网关模型 ID 键），
    // manualOverrides 只保留进程旗标真正消费的键；dsh/zcode 常驻提示按服务端 diff 门控。
    expect(source).toContain("buildGatewayModelId(targetId, selectedModel)");
    expect(source).toContain("appliedButRequiresRestart");
    // 2026-10-06：ZCode 运行中常驻提示改为“完全退出重开以加载最新模型与默认选择”。
    expect(source).toContain("最新的供应商与模型列表会自动加载");
    // 2026-10-06 用户实测确认：dsh 免重启（profile/凭据按请求解析），不再要求重启。
    expect(source).toContain("下一请求即生效");
    // 2026-10-08：挂载以空目录预检，由响应 lastProjectDir 统一回填显示（见专项回归测试）。
    expect(source).toContain('return runPreflight("", loaded.nonce)');
    expect(source).toContain("body.lastProjectDir");
    // 「来源：本次手动设置」等冗余文案已移除。
    expect(source).not.toContain("来源：");
    // dsh 启动方式一行式文案。
    // dsh 双形态并入统一「启动方式」下拉（2026-10-05）：客户端为专属 option，
    // 未安装禁用；终端选项即 Web 服务形态。zcode 高级设置默认展开。
    expect(source).toContain('<option value="dsh-app"');
    expect(source).toContain("DeepSeek Harness 客户端");
    expect(source).toContain('open={cli === "dsh" || cli === "zcode"}');
  });

  test("选择项目目录不得重置默认供应商/模型/密钥/终端（2026-09-18 用户确认）", async () => {
    const source = await readFile("src/components/development-launch-dialog.tsx", "utf8");
    // 历史缺陷：chooseProjectDirectory 会清空这几个状态并以 resetModel=true 重跑预检，
    // 导致「选完项目目录后默认模型突然变回之前的」。
    const chooser = source.slice(
      source.indexOf("async function chooseProjectDirectory()"),
      source.indexOf("async function runPreflight("),
    );
    expect(chooser).not.toContain('setCredentialId("")');
    expect(chooser).not.toContain('setTerminal("")');
    expect(chooser).not.toContain('setSelectedModel("")');
    expect(chooser).not.toContain("resetModel");
    // 选目录只更新目录本身，并以 resetModel=false 重跑预检。
    expect(chooser).toContain("setProjectDir(selection.path)");
    expect(chooser).toContain("runPreflight(selection.path, selection.nonce, false)");
    // 用户显式选过模型后，任何预检都不得覆盖（闩锁只在切换默认供应商时复位）。
    expect(source).toContain("modelUserPickedRef");
    expect(source).toContain("if (resetModel || (!modelModified && !modelUserPickedRef.current))");
  });

  test("弹窗不改动默认链：只有点「打开 {Agent}」才写配置并同步 CLI", async () => {
    const service = await readFile("src/lib/development-launch/service.ts", "utf8");
    // 弹窗内的三个接口都只读：capabilities / preflight / select-directory。
    const dialog = await readFile("src/components/development-launch-dialog.tsx", "utf8");
    expect(dialog).toContain('"/api/development-launch/capabilities"');
    expect(dialog).toContain('"/api/development-launch/preflight"');
    expect(dialog).toContain('"/api/development-launch/select-directory"');
    expect(dialog).toContain('"/api/development-launch/start"');
    // 配置写入只出现在 start 链路（persistDevelopmentPreferences），preflight 里没有。
    const preflight = service.slice(
      service.indexOf("async preflight("),
      service.indexOf("async listCredentials("),
    );
    expect(preflight).not.toContain("updateConfig");
    expect(preflight).not.toContain("cliConfigSyncer");
    expect(service).toContain("persistDevelopmentPreferences");
  });

  test("高级设置预填存量偏好优先；启动成功统一自动关窗（2026-10-08 用户确认）", async () => {
    const dialog = await readFile("src/components/development-launch-dialog.tsx", "utf8");
    // 预填顺序：已落库 launchPreferences（按网关复合键取当前模型条目）优先于目录默认。
    expect(dialog).toContain("preflight?.launchPreferences");
    expect(dialog).toContain("storedWindow");
    expect(dialog).toContain("storedAutoCompact");
    // 启动成功后统一自动关窗（2026-10-08 取代 2026-10-06「重启类提示常驻」口径）：
    // Codex 客户端带 preferenceApplyHint（条件式重启长文案）或 2026-10-09 形态切换
    // 回执（需完全退出重开）时延长到 1.5s，其余 700ms。
    // zcode 运行中常驻提示在上方 alreadyRunning 分支提前返回，不受本口径影响。
    expect(dialog).toContain("const closeDelayMs = (body.preferenceApplyHint && isCodexClientMode) || formSwitchNote ? 1500 : 700");
    expect(dialog).toContain("window.setTimeout(onClose, closeDelayMs)");
    expect(dialog).not.toContain("persistNotice");
    expect(dialog).toContain("最新的供应商与模型列表会自动加载");
    // preSync 同步警告如实附在启动结果文案里。
    expect(dialog).toContain("appliedSyncWarnings");
  });

  test("打开弹窗会显示该供应商上次成功启动的项目目录（2026-08-26 lastDir 回归修复）", async () => {
    const source = await readFile("src/components/development-launch-dialog.tsx", "utf8");
    // 历史缺陷：挂载把上次目录直接带进预检请求（省一次往返）但不落输入框状态，
    // 且非空 path 恰好跳过唯一负责显示的兜底分支——claude/opencode/zcode 每次
    // 打开都是空目录、必填目录时启动按钮被挡，用户每次都得重选。
    // 修复：挂载/切供应商一律以空目录预检，由响应 lastProjectDir（服务端 reload
    // 磁盘、按当前激活目标，比父组件 target prop 新鲜）统一回填显示。
    expect(source).not.toContain("const lastDir");
    expect(source).not.toContain("runPreflight(lastDir");
    // 兜底分支回填显示 + 递归校验目录存在性，失效时清空待用户重选。
    expect(source).toContain("setProjectDir(body.lastProjectDir)");
    expect(source).toContain("runPreflight(body.lastProjectDir, body.nonce, resetModel)");
  });
});

describe("推理强度默认档统一", () => {
  test("弹窗预填默认档与 CLI 适配器共用 resolveDefaultReasoningLevel 推断链（2026-10-06 取代 pickHighAware 兜底）", async () => {
    const service = await readFile("src/lib/development-launch/service.ts", "utf8");
    // 预填默认档必须走共享推断（anthropic/responses → xhigh、其余 → max，落表校验），
    // 保证弹窗展示的默认值 = 不打开弹窗时适配器实际写入受管配置的值。
    expect(service).toContain("resolveDefaultReasoningLevel(modelId, template)");
    expect(service).not.toContain("pickHighAwareDefaultLevel");
    const codexAdapter = await readFile("src/lib/config-sync/adapters/codex.ts", "utf8");
    expect(codexAdapter).toContain("resolveDefaultReasoningLevel(modelId, template)");
  });
});

describe("development launch dialog codex CLI 形态联动（2026-10-09 用户确认，仅 codex）", () => {
  test("弹窗展示当前 CLI 形态徽标，联动闸门走策略声明而非 agent 名分派", async () => {
    const source = await readFile(
      new URL("../src/components/development-launch-dialog.tsx", import.meta.url),
      "utf-8",
    );

    // 摘要区形态徽标（网关/官方）与「启动时将切换」提示。
    expect(source).toContain("development-cli-form-badge");
    expect(source).toContain("网关模式");
    expect(source).toContain("官方模式");
    expect(source).toContain("启动时将切换为");
    // 联动闸门 = supportsOfficialFormLaunch 声明（claude 未声明即零涉及）。
    expect(source).toContain("strategy.supportsOfficialFormLaunch === true");
    expect(source).toContain("codexCliFormForTarget");
  });

  test("形态不符时启动按钮即确认：先切换再启动，切换失败中止启动", async () => {
    const source = await readFile(
      new URL("../src/components/development-launch-dialog.tsx", import.meta.url),
      "utf-8",
    );

    expect(source).toContain("确认切换为${requiredGateway ? \"网关\" : \"官方\"}模式并启动");
    expect(source).toContain("await onSetCliForm!(cli, requiredGateway)");
    expect(source).toContain("CLI 形态切换失败，已取消本次启动");
    expect(source).toContain("已切换为${switchingGateway ? \"网关\" : \"官方\"}模式并重写受管配置");
  });

  test("官方直连形态隐藏模型/密钥/目录条目类高级设置且不提交偏好", async () => {
    const source = await readFile(
      new URL("../src/components/development-launch-dialog.tsx", import.meta.url),
      "utf-8",
    );

    // 官方模式：模型字段替换为说明、启动载荷不带模型与偏好（空对象会清除已落库偏好）。
    expect(source).toContain("selectedModel: officialLaunch ? undefined : selectedModel");
    expect(source).toContain("usesLaunchPreferences && !officialLaunch");
    expect(source).toContain("模型在 Codex 客户端内选择（ChatGPT 官方登录），无需在此选择");
    // 沙箱是 Codex 原生顶层键保留；目录条目类字段（推理档/上下文/压缩阈值）隐藏。
    expect(source).toContain("{!officialLaunch ? (");
    // codex 订阅目标的旧死路提示退役：订阅提示只对未联动 Agent 展示（claude 保持原文案）。
    expect(source).toContain("subscription && !cliFormLinked");
  });

  test("父组件接线：管理页与仪表盘都传入当前形态与切换回调", async () => {
    const management = await readFile(
      new URL("../src/components/proxy-management-page.tsx", import.meta.url),
      "utf-8",
    );
    const dashboard = await readFile(
      new URL("../src/components/dashboard/dashboard-launcher.tsx", import.meta.url),
      "utf-8",
    );

    // 管理页复用切换内核（与 Agent 接入页同链路），仪表盘自行实现同链路。
    expect(management).toContain("async function performCliFormSwitch");
    expect(management).toContain("onSetCliForm={performCliFormSwitch}");
    expect(management).toContain("cliSyncEnabled={config.agentConnections[developmentTarget.cli]?.cliSyncEnabled !== false}");
    expect(dashboard).toContain("agentConnectionPatch: {agent, action: \"connect\", cliSyncEnabled: gatewayMode}");
    expect(dashboard).toContain("onSetCliForm={setCliForm}");
  });

  test("观测状态区文案按 Agent 查声明表，删除硬编码 ZCode 口径", async () => {
    const status = await readFile(
      new URL("../src/components/agent-local-source-status.tsx", import.meta.url),
      "utf-8",
    );
    expect(status).toContain("localImportStatusCopyForAgent");
    expect(status).not.toContain("ZCode 内使用官方自带模型直连时");
    // codex 文案（规则限制口径）落在共享声明表。
    const presets = await readFile(
      new URL("../src/lib/agent-local-source/presets.ts", import.meta.url),
      "utf-8",
    );
    expect(presets).toContain("OpenAI 登录协议限制");
    expect(presets).toContain("官方积分折扣");
  });
});
