import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf-8"));

describe("SQLite 会话追踪与一级页面外壳", () => {
  test("首页只使用有界 SQLite 六级工作台查询", () => {
    const page = readFileSync("src/app/sessions/page.tsx", "utf-8");
    const root = readFileSync("src/app/page.tsx", "utf-8");
    const client = readFileSync("src/components/harness-workbench.tsx", "utf-8");
    const selection = readFileSync("src/components/workbench/use-workbench-selection.ts", "utf-8");
    const tree = readFileSync("src/components/workbench/thread-tree.tsx", "utf-8");

    // 根路径默认进入仪表盘；会话追踪迁移到 /sessions 后仍使用有界 SQLite 工作台查询。
    expect(root).toContain('redirect("/dashboard")');
    expect(page).toContain("getDeepaaDatabase");
    expect(page).toContain("loadWorkbenchTree");
    expect(page).toContain("limit: 50");
    expect(page).toContain('"thread"');
    expect(page).not.toContain("loadWorkbenchTreeState");
    expect(page).not.toContain("loadHarnessWorkbenchState");
    expect(client).toContain("ThreadTree");
    // 设计过程用的页头引导区已下线；保留选中行→目标面板的连接线交互。
    expect(client).not.toContain("WorkbenchGuide");
    expect(client).not.toContain("先定位会话范围");
    expect(client).toContain("workbench-connector");
    expect(client).toContain("洞察 · 会话树");
    // 聚合条退役后，客户端不得再保留 scope 统计拉取链路。
    expect(client).not.toContain("loadScope");
    expect(client).not.toContain("/api/cost/");
    expect(client).toContain("WORKBENCH_NODE_CACHE_CAPACITY = 8");
    expect(client).toContain("SQLITE_PAGE_LIMIT = 50");
    expect(client).toContain("/api/workbench-version");
    expect(client).toContain("/api/workbench-tree");
    // 会话树分页失败必须落到可见的错误提示与重试入口：该错误键曾只写进错误表、
    // 无人渲染，导致「加载更多 Session」失败时完全没有反馈。
    expect(client).toContain("TREE_MORE_KEY");
    expect(client).toContain("requestErrors.get(TREE_MORE_KEY)");
    expect(client).toContain('filters.set("treeScope", "global")');
    expect(client).toContain("/api/agent-sessions/");
    expect(client).toContain("/threads");
    expect(client).toContain("/api/agent-threads/");
    expect(client).toContain("/turns");
    expect(client).toContain("turnStepsPageRequestUrl");
    expect(client).toContain("无工具动作");
    expect(selection).toContain('params.set("thread", selection.thread)');
    expect(tree).toContain("parentAgentThreadId");
    expect(tree).toContain("loadChildThreads");
  });

  test("首页不再携带旧巨型工作台和旧索引入口", () => {
    const client = readFileSync("src/components/harness-workbench.tsx", "utf-8");
    const appState = readFileSync("src/lib/app-state.ts", "utf-8");

    for (const legacySymbol of [
      "LegacyHarnessWorkbenchProps",
      "WorkbenchRefreshState",
      "CaptureFilters",
      "workbenchRuntimeFromTree",
      "loadTurnWorkbenchDetail",
      "loadSessionDetail",
      "/api/capture-index",
      "/api/workbench-index",
    ]) {
      expect(client).not.toContain(legacySymbol);
    }
    expect(appState).not.toContain("capture-index");
    expect(appState).not.toContain("business-index");
    expect(appState).not.toContain("loadWorkbenchTreeState");
  });

  test("App Router 只暴露 SQLite 层级和按需证据 API", () => {
    const requiredPaths = [
      "next.config.ts",
      "src/app/layout.tsx",
      "src/app/page.tsx",
      "src/app/globals.css",
      "src/lib/app-state.ts",
      "src/app/api/agent-sessions/[agentSessionId]/threads/route.ts",
      "src/app/api/agent-threads/[threadId]/turns/route.ts",
      "src/app/api/agent-turns/[turnId]/steps/route.ts",
      "src/app/api/workbench-tree/route.ts",
      "src/app/api/workbench-version/route.ts",
      "src/app/api/workbench-selection/route.ts",
      "src/app/api/cost/[scopeType]/[scopeId]/route.ts",
      "src/app/api/exchanges/[exchangeId]/route.ts",
      "src/app/api/export/route.ts",
      "src/app/api/token-pricing/route.ts",
    ];
    for (const path of requiredPaths) {
      expect(existsSync(path), `${path} should exist`).toBe(true);
    }
    for (const path of [
      "src/app/api/business-index/route.ts",
      "src/app/api/capture-index/route.ts",
      "src/app/api/workbench-index/route.ts",
      "src/app/api/cost/[id]/route.ts",
    ]) {
      expect(existsSync(path), `${path} should be removed`).toBe(false);
    }
  });

  test("会话树各层可独立折叠且 Step 展示真实工具动作", () => {
    const client = readFileSync("src/components/harness-workbench.tsx", "utf-8");
    const tree = readFileSync("src/components/workbench/thread-tree.tsx", "utf-8");
    const treeMeta = readFileSync("src/components/workbench/tree-node-meta.tsx", "utf-8");
    const css = readFileSync("src/app/globals.css", "utf-8");

    expect(client).toContain("expandedAgentIds");
    expect(client).toContain("expandedSessionIds");
    expect(client).toContain("expandedThreadIds");
    expect(client).toContain("toggleAgent");
    expect(client).toContain("toggleSession");
    expect(client).toContain("toggleThread");
    expect(client).toContain("timelineTitle(row.step)");
    expect(client).toContain("function timelineBody(");
    expect(client).not.toContain("注册0个工具");
    expect(tree).toContain("event.stopPropagation()");
    expect(tree).toContain("compactHierarchicalId");
    expect(client).not.toContain("active-hierarchy");
    expect(client).toContain("<TreeNodeMeta");
    expect(tree).toContain("<TreeNodeMeta");
    expect(treeMeta).toContain("formatRelativeLocalTime");
    expect(client).toContain("RELATIVE_TIME_REFRESH_MS = 15_000");
    expect(client).toContain("setRelativeNowMs(Date.now())");
    expect(client).toContain("window.setInterval(refreshRelativeNow, RELATIVE_TIME_REFRESH_MS)");
    expect(treeMeta).toContain("formatRelativeLocalTime(endTime, nowMs)");
    expect(tree).toContain("nowMs={nowMs}");
    expect(css).toContain("--tree-session-active-bg");
    expect(css).toContain("--tree-thread-active-bg");
    expect(css).toContain("--tree-turn-active-bg");
    expect(css).toContain("--tree-agent-header-bg");
    expect(css).toContain(".sqlite-workbench .tree-turn.selected-scope");
    expect(css).toContain(".sqlite-workbench .workbench-panel-head .rail-mark");
    expect(css).not.toContain(".tree-session-branch.active-hierarchy .tree-row.tree-turn");
  });

  test("随版本价格快照被精确纳入发布文件且其余运行时数据继续忽略", () => {
    const gitignore = readFileSync(".gitignore", "utf-8");

    expect(packageJson.files).toContain("data/defaults/litellm-model-prices.snapshot.json");
    expect(gitignore).toContain("!data/defaults/");
    expect(gitignore).toContain("!data/defaults/litellm-model-prices.snapshot.json");
  });

  test("本 Turn 用户输入：正文直接完整渲染，自动补全走有界交互内容通道", () => {
    const client = readFileSync("src/components/harness-workbench.tsx", "utf-8");
    const queries = readFileSync("src/lib/db/workbench-queries.ts", "utf-8");

    // 预览上限只有 4 KiB（Content Preview 单条 user_real 预算）。正文必须直接渲染
    // 完整内容（固定高度 + 内部滚动），头部只保留标题与「复制」；不允许再出现
    // 「预览 N 字 / 原文约 X KB / 读取完整」点击链路（2026-09-19 用户确认）。
    expect(client).toContain("USER_PROMPT_FULL_READ_MAX_BYTES = 8 * 1024 * 1024");
    expect(client).not.toContain("预览 ${prompt.text.length} 字");
    expect(client).not.toContain("读取完整");
    expect(client).not.toContain("超出预读预算");
    expect(client).toContain("<span>本 Turn 用户输入</span>");
    // 自动补全仍必须复用交互内容的有界读取通道：scope=step + 单侧 request +
    // user_real 过滤 + pageMaxBytes 字节预算，禁止整段 session/run 级加载。
    expect(client).toContain("`/api/export/content?${query}`");
    expect(client).toContain('step: prompt.stepId');
    expect(client).toContain('scope: "step"');
    expect(client).toContain('side: "request"');
    expect(client).toContain('categories: ["user_real"]');
    expect(client).toContain("exchangeLimit: 1");
    expect(client).toContain("pageMaxBytes: USER_PROMPT_FULL_READ_MAX_BYTES");
    expect(client).toContain("pickTurnUserPromptItem");
    // 服务端必须返回首步定点锚点（stepId/exchangeId），供自动补全精确落点。
    expect(queries).toContain("stepId: row.step_id");
    expect(queries).toContain("exchangeId: row.exchange_id");
    // 预览与自动补全两端共用同一套注入信封识别与选取规则。
    const shared = readFileSync("src/lib/user-prompt-text.ts", "utf-8");
    expect(shared).toContain("export function pickTurnUserPromptItem");
  });

  test("概览：请求状态着色、业务ID块、估算真实成本与中文模型参数（2026-09-19）", () => {
    const client = readFileSync("src/components/harness-workbench.tsx", "utf-8");
    const queries = readFileSync("src/lib/db/workbench-queries.ts", "utf-8");

    // 请求状态按状态码着色：2xx 绿 / 4xx、5xx 红，无状态码保持中性。
    expect(client).toContain('label="请求状态" value={status} tone={statusTone}');
    expect(client).toContain('step.httpStatus >= 400 ? "bad" as const : "good" as const');
    // Exchange 字段下线，换为估算真实成本；价格成本「实际成本」改名并新增同口径字段。
    expect(client).not.toContain('label="Exchange"');
    expect(client).toContain("function estimatedRealCostOf(");
    // 估算真实成本为全通道统一字段（2026-09-23）：标签随通道切换——套餐/订阅行
    // 标注「估算真实成本（套餐成本估算）」且取套餐估算值；按量行保持原标签。
    expect(client).toContain('label: "估算真实成本（套餐成本估算）"');
    expect(client).toContain('label: "估算真实成本"');
    expect(client).toContain('label={realCost?.label ?? "估算真实成本"}');
    expect(client).toContain('label="按量倍率后成本"');
    // 估算口径：按量=倍率后实际成本；套餐/订阅=积分换算的入账冻结估算，不可用如实说明。
    expect(client).toContain('channel === "plan" || channel === "subscription"');
    expect(client).toContain("估算不可用");
    // 业务 ID 块：标题「业务ID」，Session/Thread/Turn/Step 仅有业务值才展示，行尾复制。
    expect(client).toContain("function BusinessIdsFact(");
    expect(client).toContain('label: "业务 Session"');
    expect(client).toContain('label: "业务 Thread"');
    expect(client).toContain('label: "业务 Turn"');
    expect(client).toContain('label: "业务 Step"');
    expect(client).toContain("step?.nativeStepId?.trim()");
    // 服务端透出业务 ID 与套餐冻结估算字段（写入端与消费端同链路可见）。
    expect(queries).toContain("s.native_step_id");
    expect(queries).toContain("native_turn_id");
    expect(queries).toContain("u.plan_estimated_status");
    expect(queries).toContain("u.plan_credit_cost");
    // 模型参数中文化 + 上下文窗口（K，按 1024 折算）。
    expect(client).toContain('label="上下文窗口（K）"');
    expect(client).toContain('"temperature": "温度"');
    expect(client).toContain('"thinking": "思考模式"');
    expect(client).toContain("function formatContextWindowK(");
    // 价格快照解析必须保留 contextWindow（此前被丢弃导致字段永远缺省）。
    expect(queries).toContain("record.contextWindow");
    // 长上下文阶梯必须随快照保留（2026-09-24 修复：白名单剥除导致会话追踪 ？浮窗
    // 复算档位永远不命中，公式漏乘 ×2/×1.5 且不显示「长上下文档位」行）。
    expect(queries).toContain("function parseLongContextTier(");
    expect(queries).toContain("longContext ? { longContext } : {}");
    // 匹配方式对用户可读（target_model_entry 等不再裸露英文枚举）。
    expect(client).toContain('target_model_entry: "目标价格条目"');
    // 业务 ID 块必须按行展示：rows 容器覆盖 fact-wide-value 的 display:flex。
    const css = readFileSync("src/app/globals.css", "utf-8");
    expect(css).toContain(".fact.fact-wide.business-ids .business-ids-rows");
    expect(css).toContain(".fact.fact-wide.business-ids {");
    // 复制按钮透明底：优先级必须压过概览模块 .inspector-column .fact button 白底规则。
    expect(css).toContain(".sqlite-workbench .inspector-column .business-id-row .comp-link");
    // Turn 摘要：会话来源→供应商、辅助请求→总耗时（墙钟优先、求和兜底、动态刷新）。
    expect(client).toContain('label">供应商</span>');
    expect(client).toContain("function turnTotalDurationLabel(");
    expect(client).toContain("function formatTurnWallDuration(");
    expect(client).not.toContain('label">会话来源</span>');
    expect(client).not.toContain("辅助请求</span>");
    // 模型思考保留原标签（后面可能还有回答）；只有纯输出收尾叫最终回答。
    expect(client).toContain('"模型思考" : "最终回答"');
    // Token 用量：去掉「请求 Token」，新增上下文窗口（K）与上下文容量占比。
    expect(client).not.toContain('label="请求 Token"');
    expect(client).toContain('label="上下文容量占比"');
    expect(client).toContain("totalTokens / contextWindow");
    // 意图序列「完成」统计依赖服务端透出的真实 responseAction。
    expect(queries).toContain("s.response_action");
  });

  test("Session 只选择统计和折叠，Step 使用内部 ID 且交互内容按页签懒加载", () => {
    const client = readFileSync("src/components/harness-workbench.tsx", "utf-8");

    expect(client).not.toContain("stepPagesBySession");
    expect(client).not.toContain("loadSessionSteps");
    expect(client).not.toContain("session-steps:");
    expect(client).not.toContain("/api/agent-sessions/${encodeURIComponent(sessionId)}/steps");
    expect(client).toContain("step: latestStep.id");
    expect(client).toContain("step: nextStepId");
    expect(client).toContain('selection.step === row.step.id');
    expect(client).toContain('scopeType: ScopeType = selection?.step ? "step" : view');
    expect(client).toContain("ConversationExportViewer");
    expect(client).toContain("stepConversationQuery");
    expect(client).toContain('scope: "step"');
    expect(client).toContain("exchangeLimit: 2");
    // 截断横幅已按 2026-09-21 用户反馈整体移除：内部预算文案对用户无信息量，
    // 受限口径由构成面板的「估算/校准」徽标与逐行对比的截断计数承载。
    expect(client).not.toContain("部分证据未落库");
    expect(client).not.toContain("部分条目未落库");
    expect(client).not.toContain("此处展示哈希与有界摘要");
    expect(client).not.toContain("此处展示差异索引与计数");
  });

  test("跨页返回时复用 Thread 请求且分页就绪前不渲染空状态", () => {
    const client = readFileSync("src/components/harness-workbench.tsx", "utf-8");

    expect(client).toContain("threadLoadPromises");
    expect(client).toContain("const existingRequest = threadLoadPromises.current.get(key)");
    expect(client).toContain("if (existingRequest) return existingRequest");
    expect(client).toContain("rootPage ? (");
    expect(client).not.toContain("roots={(rootPage?.items || [])");
  });

  test("数据版本变化只刷新当前树、统计和当前 Turn 第一页", () => {
    const client = readFileSync("src/components/harness-workbench.tsx", "utf-8");
    const refreshStart = client.indexOf("async function refreshCurrentTree()");
    const refreshEnd = client.indexOf("async function loadProjection(", refreshStart);
    const refreshFunction = client.slice(refreshStart, refreshEnd);
    const hierarchyStart = client.indexOf("async function refreshHierarchyPaths(");
    const hierarchyEnd = client.indexOf("async function refreshCurrentTree()", hierarchyStart);
    const hierarchyFunction = client.slice(hierarchyStart, hierarchyEnd);

    expect(client).toContain("SQLITE_VERSION_POLL_MS = 2_000");
    expect(client).toContain("setDataVersion(version.dataVersion)");
    expect(client).toContain("await refreshCurrentTree();");
    // 版本轮询只做静默刷新（2026-09-29 用户确认）：任何锁定深度都仅刷新当前
    // Turn 缓存与详情，不改写选中——不存在轮询触发的自动跟随路径。
    expect(client).toContain("if (current?.turn) void loadSteps(current.turn, undefined, true)");
    expect(client).not.toContain("autoFollowLatestSelection");
    expect(client).not.toContain("autoFollowStepOnly");
    // 树刷新内容未变时保持原引用（stableJsonSignature 防闪烁），不触发整树重渲染。
    expect(client).toContain("const next = refreshWorkbenchTreePage(");
    expect(client).toContain("stableJsonSignature(currentPage) === stableJsonSignature(next)");
    expect(refreshFunction).toContain("refreshHierarchyPaths([current, page.latestPath])");
    expect(refreshFunction).not.toContain("restoreSelectionPath");
    expect(hierarchyFunction).toContain("hierarchyRefreshPlan(paths)");
    expect(hierarchyFunction).toContain("loadThreads");
    expect(hierarchyFunction).toContain("loadTurns");
    expect(hierarchyFunction).not.toContain("loadSteps");
    expect(hierarchyFunction).not.toContain("loadProjection");
    expect(client).not.toContain("Promise.all(sessionTurns.map");
  });

  test("请求响应页签按当前单侧读取格式化正文并显式打开完整 Raw", () => {
    const client = readFileSync("src/components/harness-workbench.tsx", "utf-8");
    const fullRawView = readFileSync("src/components/full-raw-body-view.tsx", "utf-8");

    expect(client).toContain("ExchangeProjectionDetail");
    expect(client).not.toContain("RawCapturedExchange");
    expect(client).toContain("async function loadProjection(");
    expect(client).toContain("/api/exchanges/${encodeURIComponent(exchangeId)}");
    expect(client).toContain("function selectInspectorTab(tab: InspectorTab)");
    expect(client).toContain("overviewEvidencePlan({");
    expect(client).toContain('active: activeTab === "总览"');
    expect(client).toContain("void loadProjection(plan.current.exchangeId, plan.current.stepId)");
    expect(client).toContain("void loadPreviousProjection(plan.previous, selectedStep.id)");
    expect(client).toContain("function WorkbenchRawInspectorTab(");
    expect(client).toContain("fetchWorkbenchRawInspectorMetadata({");
    expect(client).toContain("loadWorkbenchRawBody({");
    expect(client).toContain("const controller = new AbortController()");
    expect(client).toContain("return () => controller.abort()");
    expect(client).not.toContain("formatWorkbenchRawBodyForCopy(");
    expect(client).toContain("复制全部");
    expect(client).toContain("copyAllContent");
    expect(client).toContain('side === "request" ? "请求" : "响应"');
    expect(client).toContain('title={`${sideLabel} Headers`}');
    expect(client).toContain('`格式化${sideLabel}体 JSON`');
    expect(client).toContain("SSE 时间线");
    expect(client).toContain("SSE Events (JSON)");
    expect(client).toContain("valueContainsWorkbenchMediaMarker(event.data)");
    expect(client).toContain("非媒体正文超过 8 MiB");
    expect(client).not.toContain("SQLite 预览与派生诊断");
    expect(client).not.toContain("ProjectionAuxiliarySections");
    expect(client).toContain("buildRawMediaHref(");
    expect(client).toContain("parseWorkbenchMediaMarker(");
    expect(client).toContain("ImageIcon");
    expect(client).not.toContain("<img");
    expect(fullRawView).toContain("查看完整请求");
    expect(fullRawView).toContain("查看完整响应");
    expect(fullRawView).toContain("下载完整请求");
    expect(fullRawView).toContain("下载完整响应");
    expect(client).not.toMatch(/fetch\([^)]*\/raw\/(request|response)/s);
    expect(client).toContain("历史记录尚未生成正文预览");
    expect(client).toContain("正文当前不可用");
    expect(client).toContain("正文完整性校验失败");
    // v5：不再用「格式化正文 / 完整 Raw」分段控件与查看/下载按钮，
    // 正文直接铺开：格式化 JSON + 完整 Raw 两个模块并列。
    expect(client).not.toContain("<FullRawBodyView");
    expect(client).toContain("function RawTextLineViewer(");
    expect(client).toContain("title={`${sideLabel}完整Raw`}");
    expect(client).toContain('activeTab === "请求" ? <WorkbenchRawInspectorTab');
    expect(client).toContain('activeTab === "响应" ? <WorkbenchRawInspectorTab');
    const selectTabStart = client.indexOf("function selectInspectorTab(tab: InspectorTab)");
    const selectTabEnd = client.indexOf("function focusEvidencePath", selectTabStart);
    const selectTab = client.slice(selectTabStart, selectTabEnd);
    expect(selectTab).not.toContain("loadPreviousProjection");
    expect(fullRawView).toContain("/api/exchanges/${encodeURIComponent(exchangeId)}/raw/${side}?disposition=inline");
    expect(fullRawView).toContain('sandbox=""');
    expect(fullRawView).toContain('key={`${exchangeId}:${side}`}');
    expect(fullRawView).toContain("RAW_VIEW_CONFIRM_BYTES = 8 * 1024 * 1024");
    expect(fullRawView).toContain("RAW_DOWNLOAD_RECOMMEND_BYTES = 32 * 1024 * 1024");
    expect(fullRawView).toContain("if (sizeBytes <= RAW_VIEW_CONFIRM_BYTES)");
    expect(fullRawView).toContain("sizeBytes > RAW_DOWNLOAD_RECOMMEND_BYTES");
    expect(fullRawView).toContain('useState<RawBodyMode>("formatted")');
    expect(fullRawView).toContain("useState(false)");
    expect(fullRawView).toContain("loadApproved ? inlineHref : undefined");
    expect(fullRawView).toContain("if (!await confirmDialog");
    expect(fullRawView).toContain('target="_blank"');
    expect(fullRawView).toContain("disposition=attachment");
    expect(fullRawView).toContain("格式化正文");
    expect(fullRawView).toContain('mode === "raw"');
    expect(fullRawView).not.toMatch(/fetch\([^)]*\/raw\//s);
  });

  test("首页恢复基线版可折叠拖拽三栏与完整步骤检查器", () => {
    const client = readFileSync("src/components/harness-workbench.tsx", "utf-8");
    const css = readFileSync("src/app/globals.css", "utf-8");

    expect(client).toContain('column="capture"');
    expect(client).toContain('column="timeline"');
    expect(client).toContain("ColumnResizeHandle");
    expect(client).toContain("toggleColumnCollapsed");
    expect(client).toContain("startColumnDrag");
    expect(client).toContain('className="inspector-header"');
    expect(client).toContain('aria-label="步骤检查器标签"');
    // 页签顺序（2026-09-18）：事实页签在前，问题页签在后；「变化」已并入
    // 「上下文」（压缩/演化）与「能力清单」（Harness Diff），六页签结构。
    for (const tab of ["总览", "请求", "响应", "上下文", "交互内容", "能力清单"]) {
      expect(client).toContain(`"${tab}"`);
    }
    expect(client).not.toContain('"变化"');
    // 旧深链 tab=diff / tab=change 向后兼容映射到「上下文」。
    expect(client).toContain('diff: "上下文"');
    expect(client).toContain('change: "上下文"');
    expect(client).not.toContain('className="tab-strip sqlite-raw-tabs"');
    // 协议能力面板（2026-09-18）：能力清单页签以本步数据展示 wire API 差异；
    // 总览事实格新增「协议」字段。旧深链 tab=diff/change 映射到「上下文」。
    expect(client).toContain("function ProtocolCapabilityPanel(");
    expect(client).toContain("function protocolLabel(");
    expect(client).toContain('case "openai-responses": return "Responses"');
    expect(client).toContain('case "openai-chat-completions": return "Chat Completions"');
    expect(client).toContain('case "anthropic-messages": return "Messages"');
    expect(client).toContain("<ProtocolCapabilityPanel protocol={protocol} isStreaming={isStreaming} step={step} />");
    expect(client).toContain('<Fact label="请求协议" value={protocolLabel(projection?.preview.protocol)} />');
    // 「变化」并入「上下文」：压缩事件与上下文演化段就位。
    expect(client).toContain("function ContextEvolutionSection(");
    expect(client).toContain("<ContextEvolutionSection diff={diff} harness={harness} />");
    // 三栏间距已由 28px 收窄为 8px 竖线，折叠按钮由 28×68 缩为 18×28 胶囊。
    expect(css).toContain("8px\n    minmax(280px, var(--timeline-column-width, 320px))\n    8px");
    expect(css).toContain(".collapse-column-button");
    expect(css).not.toContain(".sqlite-workbench .tree-chevron-button {\n  width: 44px");
  });

  test("聚合条只保留统计范围与当前 scope 路径，跳转按钮下沉到交互内容页签", () => {
    const summary = readFileSync("src/components/workbench/scope-summary.tsx", "utf-8");
    const css = readFileSync("src/app/globals.css", "utf-8");
    const exportViewer = readFileSync("src/components/conversation-export-viewer.tsx", "utf-8");
    const harness = readFileSync("src/components/harness-workbench.tsx", "utf-8");

    // 旧的 5 项聚合指标（总请求数 / 总 Token / 总消费 / 平均耗时 / 工具调用）已整体移除，
    // 跳转按钮已下沉到「交互内容」页签内的「新窗口打开」入口。
    for (const label of ["总请求数", "总消费", "平均耗时"]) {
      expect(summary).not.toContain(label);
    }
    expect(summary).not.toContain("formatSummaryTokenAmount");
    expect(summary).not.toContain("summary-view-action");
    expect(summary).not.toContain("查看本{scopeLabel}交互内容");
    expect(exportViewer).toContain("新窗口打开");
    expect(exportViewer).toContain('target="_blank"');
    expect(exportViewer).toContain("exp-actions-open");
    // embedded 操作区的「导出完整 Markdown/JSONL」已按 2026-09-21 用户决策移除：
    // 页签内只留「新窗口打开」，本 Step 导出由展开视图的「导出 Markdown / JSONL」承担。
    expect(exportViewer).not.toContain("exp-actions-btn");
    expect(css).toContain(".exp-actions .exp-actions-open");
    expect(summary).toContain("/export?");
    expect(summary).toContain('setParam(params, "thread", selection.thread)');
    expect(css).toContain(".agg-bar");
    expect(css).toContain(".agg-bar-row");
    expect(css).toContain(".agg-bar-label");
    expect(css).toContain(".proxy-target-row.expanded");
    expect(css).toContain("box-shadow: inset 3px 0 0 var(--accent)");
    expect(css).not.toContain(".proxy-target-row.expanded {\n  border-color: #bbf7d0");
    // 步骤列表的内部滚动阈值与条件 class 必须就位。
    // v5（2026-09-18 用户确认）：超过 15 个 Step 就在栏内滚动，不再撑高整页
    expect(harness).toContain("STEP_LIST_INTERNAL_SCROLL_THRESHOLD = 15");
    expect(harness).toContain("step-list-panel-scrollable");
    expect(css).toContain(".step-list-panel-scrollable");
  });

  test("代理管理支持单目标保存、revision、删除与独立 CLI 同步", () => {
    const source = readFileSync("src/components/proxy-management-page.tsx", "utf-8");
    const css = readFileSync("src/components/proxy-management/proxy-management.module.css", "utf-8");
    const route = readFileSync("src/app/api/config-sync/route.ts", "utf-8");

    expect(source).toContain("saveSelectedTarget");
    expect(source).toContain("expectedRevision");
    expect(source).toContain("targetPatch");
    expect(source).toContain("targetDelete");
    expect(source).toContain("确认删除");
    expect(source).toContain("syncCliConfiguration");
    expect(source).toContain("CONFIG_REVISION_CONFLICT");
    expect(source).toContain("ProxyResourcesTab");
    expect(source).toContain('"/api/config-sync"');
    expect(route).toContain("syncCliConfigs");
    expect(route).not.toContain("rollbackCliConfigs");
    expect(css).toContain(".notice");
    expect(css).toContain(".stickyActions");
    expect(css).toContain("grid-template-columns: 320px minmax(0, 1fr)");
  });

  test("Token 价格列表隐藏内部扫描指标并在容器内完整换行层级 ID", () => {
    const tokenPricing = readFileSync("src/components/token-pricing-content.tsx", "utf-8");
    const css = readFileSync("src/app/globals.css", "utf-8");

    expect(tokenPricing).not.toContain("已处理账本行");
    expect(tokenPricing).not.toContain("时间窗候选");
    expect(tokenPricing).toContain("TokenPricingBreakdownTable");
    expect(tokenPricing).toContain("缓存命中率");
    expect(tokenPricing).toContain("/ 1M Token");
    expect(tokenPricing).toContain('className="token-id-cell"');
    // 双行展示：DeepAA 生成值 + Agent 业务值（样式一致、不省略），tooltip 标注来源语义。
    expect(tokenPricing).toContain('token-id-deepaa" title="DeepAA系统生成"');
    expect(tokenPricing).toContain('token-id-agent" title={`${item.agentName} 业务 Session`}');
    // Step 行第二列为原生业务标识（如 dsh session:step:N）；多数 Agent 无该标识仍显示 -。
    expect(tokenPricing).toContain('title={`${item.agentName} 业务 Step`}');
    expect(tokenPricing).toContain("{item.externalStepId || \"-\"}");
    expect(tokenPricing).not.toContain("compactId(item.sessionId)");
    expect(css).not.toContain("min-width: 1900px");
    expect(css).toContain(".token-pricing-row .token-id-cell");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain(".token-breakdown-scroll");
    // 页面正文与汇总表交还浏览器原生滚动：不再有页内固定高度滚动条（2026-09-05 用户反馈）。
    // 页面容器本身不得设置任何 overflow（hidden 会破坏明细表冻结列 sticky 吸附）。
    expect(css).not.toContain("max-height: 680px");
    expect(css).toMatch(/\.token-pricing-table \{[^}]*overflow-x: auto/s);
    expect(css).not.toMatch(/\.token-pricing-page \{[^}]*overflow[xy]: /s);
    expect(css).toContain(".token-breakdown-table thead");
  });

  test("代理目标和模型汇总展示 Token 与消费合计并保留四位小数", () => {
    const tokenPricing = readFileSync("src/components/token-pricing-content.tsx", "utf-8");

    expect(tokenPricing).toContain('<th colSpan={6}>总 Token</th>');
    // 2026-09-29 用户确认删除与「总消费」恒等的「实际总消费」列，总消费组剩两列。
    expect(tokenPricing).toContain('<th colSpan={2}>总消费</th>');
    expect(tokenPricing).toContain("<th>总 Token</th>");
    expect(tokenPricing).toContain("<th>总消费</th>");
    expect(tokenPricing).not.toContain("<th>实际总消费</th>");
    expect(tokenPricing).toContain('formatSummaryMoney(item.actualCost, "CNY")');
    expect(tokenPricing).toContain('formatVendorMoney(item.vendorCost, false, "CNY")');
  });

  test("Token 价格页金额区分人民币终值与原币中间项（2026-09-28 币种标注）", () => {
    const tokenPricing = readFileSync("src/components/token-pricing-content.tsx", "utf-8");

    // 总消费卡与人民币终值走 ￥ 格式；明细行原币中间项按行币种标注。
    expect(tokenPricing).toContain("formatCnyMoney(summaryRealTotal)");
    expect(tokenPricing).toContain('formatUnitPrice(item.inputUnitPrice, item.currency)');
    expect(tokenPricing).toContain('formatVendorMoney(item.vendorCost, true, item.currency)');
    expect(tokenPricing).toContain('formatDetailMoney(item.actualCost, item.currency)');
  });

  test("Token 价格时间筛选作为整体布局且响应绑定当前查询", () => {
    const tokenPricing = readFileSync("src/components/token-pricing-content.tsx", "utf-8");
    const css = readFileSync("src/app/globals.css", "utf-8");

    expect(tokenPricing).toContain('className="token-filter-datetime-range"');
    expect(tokenPricing).toContain("resolvedSelectionQuery");
    expect(tokenPricing).toContain("queryFromFilters(filters)");
    expect(css).toContain(".token-filter-datetime-range");
    expect(css).toContain("break-inside: avoid");
    expect(css).toContain("max-width: 390px");
    expect(css).toContain("flex: 0 1 390px");
  });

  test("价格配置更新只记录未来生效版本，不重写历史账本", () => {
    const proxyRoute = readFileSync("src/app/api/proxy-config/route.ts", "utf-8");
    const pricingRoute = readFileSync("src/app/api/model-pricing/route.ts", "utf-8");
    const importRoute = readFileSync("src/app/api/model-pricing/import/route.ts", "utf-8");
    const revisions = readFileSync("src/lib/ingestion/pricing-revisions.ts", "utf-8");

    expect(proxyRoute).toContain("ensurePricingConfigRevision");
    expect(pricingRoute).toContain("ensurePricingConfigRevision");
    expect(pricingRoute).toContain("return withPricingConfigMutation(DATA_DIR, async () =>");
    expect(importRoute).toContain("refreshLiteLLMPricingCatalog");
    expect(proxyRoute).not.toContain("repriceUsageLedger");
    expect(pricingRoute).not.toContain("repriceUsageLedger");
    expect(revisions).toContain("pricing_config_revisions");
    expect(revisions).toContain("loadPricingConfigAt");
  });

  test("三个一级页面共享六级 URL 上下文和公共头部", () => {
    const nav = readFileSync("src/components/view-toggle.tsx", "utf-8");
    const shared = readFileSync("src/lib/shared-selection.ts", "utf-8");
    const header = readFileSync("src/components/app-header.tsx", "utf-8");
    const pages = [
      readFileSync("src/app/sessions/page.tsx", "utf-8"),
      readFileSync("src/app/export/page.tsx", "utf-8"),
      readFileSync("src/app/token-pricing/page.tsx", "utf-8"),
    ];

    expect(nav).toContain("会话追踪");
    expect(nav).toContain("交互内容");
    expect(nav).toContain("Token价格");
    expect(nav).toContain('"/sessions"');
    expect(nav).toContain("window.location.search");
    // 业务上下文只在三个数据页之间互带（2026-09-24 用户确认）；
    // 切向仪表盘/供应商管理不带参数，从这两页切向数据页也不带。
    expect(nav).toContain("topLevelNavHref");
    expect(shared).toContain('"/sessions"');
    expect(shared).toContain('"target", "agent", "session", "thread", "turn", "step"');
    expect(shared).toContain("SELECTION_PROPAGATION_PATHS");
    expect(header).toContain("ViewToggle");
    for (const page of pages) expect(page).toContain("AppHeader");
  });

  test("成本 ？浮窗：移出 ？ 延迟 1s 消失、移入浮框保持显示（2026-09-24）", () => {
    const help = readFileSync("src/components/cost-help.tsx", "utf-8");

    // 移出 ？ 后延迟关闭；延迟窗口内移入浮框取消关闭，移出浮框才真正关闭。
    expect(help).toContain("CLOSE_DELAY_MS = 1000");
    expect(help).toContain("onMouseLeave={scheduleClose}");
    expect(help).toContain("onMouseEnter={cancelPendingClose}");
    expect(help).toMatch(
      /onMouseEnter=\{cancelPendingClose\}[\s\S]*?onMouseLeave=\{\(\) => \{\s*cancelPendingClose\(\);\s*setAnchor\(undefined\);\s*\}\}/,
    );
  });

  test("交互内容和 Token 价格提供 Thread、Turn、Step 联动", () => {
    const exportContent = readFileSync("src/components/export-content.tsx", "utf-8");
    const exportViewer = readFileSync("src/components/conversation-export-viewer.tsx", "utf-8");
    const tokenPricing = readFileSync("src/components/token-pricing-content.tsx", "utf-8");

    expect(exportContent).toContain("ConversationExportViewer");
    expect(exportViewer).toContain("Thread");
    expect(exportViewer).toContain("Turn");
    expect(exportViewer).toContain("Step");
    expect(exportViewer).toContain("INPUT_CATS");
    expect(exportViewer).toContain("OUTPUT_CATS");
    expect(exportViewer).toContain("item.side");
    expect(tokenPricing).toContain("Thread");
    expect(tokenPricing).toContain("Turn");
    expect(tokenPricing).toContain("Step");
    expect(tokenPricing).toContain("facets?.steps");
    expect(tokenPricing).toContain("token-summary-grid");
  });

  test("交互内容按当前页增量读取完整正文并在范围变化时取消旧流", () => {
    const viewer = readFileSync("src/components/conversation-export-viewer.tsx", "utf-8");
    const client = readFileSync("src/lib/export-content-client.ts", "utf-8");
    const css = readFileSync("src/app/globals.css", "utf-8");

    expect(viewer).toContain("streamExportContentPage");
    expect(viewer).toContain("/api/export/content?");
    expect(viewer).toContain("new AbortController()");
    expect(viewer).toContain("contentRequestRef.current?.abort()");
    expect(viewer).toContain("requestGenerationRef.current");
    expect(viewer).toContain("setData(undefined)");
    expect(viewer).not.toContain("fetch(`/api/export?${requestQuery}`)");
    expect(viewer).not.toContain("受限预览：当前页仅展示 SQLite 有界内容");
    expect(viewer).toContain("当前页完整可读内容");
    expect(viewer).toContain("visibleProcessedCount");
    expect(viewer).toContain("baselineProcessedCount");
    expect(viewer).toContain("contentCompleteness");
    expect(viewer).toContain("dedupeDetailsByThread");
    expect(viewer).toContain("继承比对未确认");
    expect(viewer).toContain("lastSkippedExchangeId");
    expect(viewer).toContain("function ConversationItemView(");
    expect(viewer).toContain("open ? <div className=\"conv-detail-body\">");
    expect(client).toContain("response.body.getReader()");
    expect(client).toContain("new TextDecoder()");
    expect(client).not.toContain("response.text()");
    expect(client).not.toContain("response.json()");
    expect(viewer).toContain("confirmedOversizedExchangeId");
    expect(viewer).toContain("readExportContentError");
    expect(viewer).toContain("仅加载该 Exchange");
    expect(viewer).toContain("MAX_CONFIRMED_EXCHANGE_BYTES = 128 * 1024 * 1024");
    expect(viewer).toContain("setOversizedExchange(undefined)");
    expect(viewer).toContain("/raw/request?disposition=inline");
    expect(viewer).toContain("/raw/response?disposition=attachment");
    expect(viewer).toContain("groupExportContentExchanges");
    expect(viewer).toContain("function ExchangeSidePlaceholder(");
    expect(viewer).toContain("hiddenInheritedInputCount");
    expect(viewer).toContain("未产生可展示的模型输出");
    expect(viewer).not.toContain("exchange.diagnosticCandidateCount > 0");
    expect(viewer).not.toContain("exchange.diagnosticCodes.length > 0");
    expect(viewer).toContain("exchange.contentError ? (");
    expect(viewer).toContain("正文读取失败:");
    expect(css).toContain(".conv-side-placeholder");
    expect(css).toContain(".exchange-http-status.error");
    expect(css).toContain(".exchange-content-error");
  });

  test("上下文分层卡片逐层可展开并支持查看原文跳转", () => {
    const client = readFileSync("src/components/harness-workbench.tsx", "utf-8");
    // 六层卡片齐备
    for (const layer of ["系统提示", "规则注入", "Skills 注入", "工具定义", "对话上下文", "工具结果"]) {
      expect(client).toContain(`title="${layer}"`);
    }
    expect(client).toContain("function ContextLayerCards");
    expect(client).toContain("function LayerCard");
    // 每层带规模（条数 + tokens 估算）与可折叠
    expect(client).toContain("layer-card-meta");
    expect(client).toContain("aria-expanded={open}");
    // 「查看原文 →」跳转到交互内容并携带过滤
    expect(client).toContain("onOpenInteraction");
    expect(client).toContain('label: "查看原文 →"');
    expect(client).toContain('categories: ["tool_result"]');
    expect(client).toContain('categories: ["user_injected"]');
    expect(client).toContain("setInteractionCategoryFilter(filter.categories)");
    expect(client).toContain("setInteractionToolFilter(filter.toolName)");
    // 2026-09-21：分类下钻不再进查询串（scope=step 的列表候选被类别过滤会整页
    // 滤成空），改为 drillCategories prop 由展开详情条目过滤承担，随选择变化重建 viewer。
    expect(client).toContain("interactionCategoryFilter");
    expect(client).toContain("drillCategories={interactionCategoryFilter}");
    expect(client).not.toContain("categories: interactionCategoryFilter");
    // 结构事实默认收起（哈希属实现细节）
    expect(client).toContain("const [structureFactsOpen, setStructureFactsOpen] = useState(false)");
  });

  test("交互内容筛选由 URL 唯一恢复，翻页退化为无限加载", () => {
    const exportContent = readFileSync("src/components/export-content.tsx", "utf-8");
    const viewer = readFileSync("src/components/conversation-export-viewer.tsx", "utf-8");
    const syncEffectStart = viewer.indexOf("useEffect(() => {\n    const next = parseQuery(initialQuery);");
    const syncEffectEnd = viewer.indexOf("\n  }, [initialQuery, mode]);", syncEffectStart);
    const syncEffect = viewer.slice(syncEffectStart, syncEffectEnd);

    expect(exportContent).toContain('navigation === "push"');
    expect(exportContent).toContain("router.push(");
    expect(exportContent).toContain("router.replace(");
    // 2026-09-17 用户确认：翻页参数不再进 URL，改为底部「加载更多（更早）」无限加载；
    // 列表行零 raw（summaryOnly），展开某步才按需读 raw。
    expect(viewer).not.toContain('direction: "older", page: pageNumber + 1');
    expect(viewer).toContain("summaryOnly");
    expect(viewer).toContain("deferBaseline");
    expect(viewer).toContain("加载更多（更早）");
    expect(viewer).toContain("streamExportListPage");
    expect(viewer).toContain("完整上下文");
    expect(viewer).toContain("本步新增");
    expect(viewer).toContain("触底自动加载");
    expect(viewer).toContain('onQueryChange?.(nextQuery, navigation)');
    expect(viewer).not.toContain("cursorHistory");
    expect(syncEffectStart).toBeGreaterThanOrEqual(0);
    expect(syncEffect).not.toContain("contentRequestRef.current?.abort()");
    expect(viewer).toContain("当前总数仅包含已确认匹配项");
    expect(viewer).toContain("filterProjectionMissingCount");
    expect(viewer).toContain("filterProjectionLimitedCount");
  });

  test("桌面和移动端工作台具备稳定尺寸与无障碍状态", () => {
    const css = readFileSync("src/app/globals.css", "utf-8");
    const client = readFileSync("src/components/harness-workbench.tsx", "utf-8");

    expect(css).toContain(".workbench.capture-collapsed");
    expect(css).toContain(".workbench.timeline-collapsed");
    expect(css).toContain(".column-resize-handle");
    expect(css).toContain("min-width: 0");
    expect(css).toContain("@media (max-width: 767px)");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(".tree-row-main:focus-visible");
    // 2026-09-18 用户确认：时间范围下的内嵌状态区移除（出现/消失引起整页抖动），
    // 提示改为 fixed 浮动 toast（恢复进度 pill + 自动消失通知），不占布局。
    expect(client).not.toContain("sqlite-workbench-status-stack");
    expect(css).not.toContain(".sqlite-workbench-status-stack");
    expect(css).toContain(".workbench-progress-toast");
    expect(css).toContain(".workbench-toast");
    expect(client).toContain("workbench-progress-toast");
    expect(client).toContain("workbench-toast");
    expect(client).toContain('className="tab-strip"');
    expect(client).toContain('EmptyState text="暂无会话数据"');
    expect(client).toContain('"暂无 Step 数据"');
    expect(client).toContain('"未选择步骤"');
    expect(client).not.toContain("等待 SQLite Worker 派生会话");
    expect(client).toContain('role="status"');
    expect(client).toContain('role="alert"');
  });

  test("Next、React 与 Node 代理脚本保持现有技术栈", () => {
    expect(packageJson.dependencies.next).toMatch(/^16\./);
    expect(packageJson.dependencies.react).toMatch(/^19\./);
    expect(packageJson.dependencies["react-dom"]).toMatch(/^19\./);
    // 运行类脚本与 deepaa 命令同名镜像（2026-10-05 用户确认）
    expect(packageJson.scripts["dev:web"]).toBe("node ./bin/deepaa.mjs dev web");
    expect(packageJson.scripts["dev:proxy"]).toBe("node ./bin/deepaa.mjs dev proxy");
    expect(packageJson.scripts.test).toBe("pnpm test:vitest && pnpm test:sqlite");
    expect(packageJson.scripts.typecheck).toContain("tsc --noEmit");
  });

  test("代理管理页面和价格中心入口", () => {
    const header = readFileSync("src/components/app-header.tsx", "utf-8");
    const proxySettings = readFileSync("src/components/proxy-management-page.tsx", "utf-8");
    const pricingSettings = readFileSync("src/components/pricing-settings-dialog.tsx", "utf-8");
    const instrumentation = readFileSync("src/instrumentation.ts", "utf-8");

    expect(header).toContain("PricingSettingsDialog");
    expect(header).not.toContain("ProxySettingsDialog");
    expect(proxySettings).toContain("AgentEntryBadges");
    expect(proxySettings).not.toContain("AgentDefaultEntryDialog");
    expect(proxySettings).toContain("DevelopmentLaunchDialog");
    expect(proxySettings).not.toContain("AgentEntryList");
    expect(proxySettings).toContain("ProxyTargetSidebar");
    expect(proxySettings).toContain("ProxyResourcesTab");
    expect(proxySettings).toContain("新建供应商");
    expect(pricingSettings).toContain("价格中心");
    expect(pricingSettings).toContain("const CATALOG_LIMIT = 50");
    expect(instrumentation).toContain("startPricingImportScheduler");
    expect(instrumentation).toContain('process.env.NEXT_RUNTIME !== "nodejs"');
    expect(instrumentation).toContain('process.env.NEXT_PHASE === "phase-production-build"');
  });

  test("仪表盘 KPI 趋势线、Agent 固定顺序与时区值域统一", () => {
    const dashboard = readFileSync("src/components/dashboard-content.tsx", "utf-8");
    const timezones = readFileSync("src/lib/timezones.ts", "utf-8");
    const tokenPricing = readFileSync("src/components/token-pricing-content.tsx", "utf-8");

    // 总请求数 KPI 趋势线与其余三卡同色（白色曲线在浅色卡片上不可见）。
    expect(dashboard).toContain("<Sparkline values={hourValues} color={COLOR_MAIN} />");
    // Agent 列表按注册表顺序固定展示：Codex → Claude Code → OpenCode → DeepSeek Harness → ZCode。
    expect(dashboard).toContain("sortAgentsByDisplayOrder");
    expect(dashboard).toContain("AGENT_DISPLAY_ORDER");
    expect(dashboard).toContain("agentLabel(agent.agent)");
    // 两个一级页面共用固定 11 项时区值域，默认 UTC+8（上海）。
    expect(timezones).toContain('DEFAULT_TIME_ZONE = "UTC+8"');
    for (const zone of [
      "UTC-8（洛杉矶）",
      "UTC-6（芝加哥）",
      "UTC-5（纽约）",
      "UTC+0（伦敦）",
      "UTC+1（柏林）",
      "UTC+3（莫斯科）",
      "UTC+4（迪拜）",
      "UTC+7（曼谷）",
      "UTC+8（上海）",
      "UTC+9（东京）",
      "UTC+10（悉尼）",
    ]) {
      expect(timezones).toContain(zone);
    }
    expect(timezones).not.toContain("UTC-12");
    expect(tokenPricing).toContain('from "@/lib/timezones"');
    expect(dashboard).toContain('from "@/lib/timezones"');
  });

  test("会话追踪分层自动跟随最新 Thread/Turn/Step，手动点选按层级级联锁定", () => {
    const client = readFileSync("src/components/harness-workbench.tsx", "utf-8");

    // 深链：携带 step 锁定到 Step，仅 turn 锁定到 Turn，否则全自动跟随。
    expect(client).toContain("function initialManualLockDepth(initialQuery: string): number {");
    expect(client).toContain('if (params.get("step")?.trim()) return 4;');
    expect(client).toContain('if (params.get("turn")?.trim()) return 3;');
    expect(client).toContain("const manualLockDepthRef = useRef(initialManualLockDepth(initialQuery));");

    // 点击 Session/Thread：手动锁定该层并自动下钻最新 Thread → Turn → Step（点选时刻一次性承接）。
    expect(client).toContain("manualLockDepthRef.current = 1;");
    expect(client).toContain("manualLockDepthRef.current = 2;");
    expect(client).toContain("async function autoSelectSessionLatest");
    expect(client).toContain("async function autoSelectThreadLatest");
    expect(client).toContain("const latestStep = stepPage?.steps[0];");
    // 轮询触发的自动跟随已整体移除（2026-09-29 用户确认）：后台新数据永不改写选中。
    expect(client).not.toContain("async function autoFollowLatestSelection");
    expect(client).not.toContain("async function autoFollowStepOnly");

    // 锁定守卫：Thread 锁定后 Session 下钻停止；Turn 锁定后 Thread 下钻停止。
    expect(client).toContain("if (manualLockDepthRef.current >= 2 || selectionRef.current?.session !== sessionId) return false;");
    expect(client).toContain("if (manualLockDepthRef.current >= 3 || selectionRef.current?.thread !== threadId) return false;");

    // 手动点选 Turn：Turn 及上层锁定，点选时刻一次性补选该 Turn 最新 Step；点选 Step 全锁定。
    expect(client).toContain("manualLockDepthRef.current = 3;");
    expect(client).toContain("if (manualLockDepthRef.current !== 3 || selectionRef.current?.turn !== turnId) return;");
    expect(client).toContain("function selectStep(step: AgentStep): void {\n    // 手动点选 Step：全层级锁定，不再自动跟随。\n    manualLockDepthRef.current = 4;");

    // 版本轮询（2026-09-29 用户确认）：只静默刷新当前 Turn 的 Step 缓存与当前 Step
    // 详情，任何锁定深度都不推进选中，正在查看的 Step/第三栏（含全屏）不被拉走。
    expect(client).toContain("// 轮询只做静默刷新（2026-09-29 用户确认，取代分层自动跟随）");
    expect(client).not.toContain("if (manualLockDepthRef.current < 4) {");
    // 下钻无变化时不重复写选中路径，避免每 2 秒轮询造成无意义重渲染。
    expect(client).toContain("if (current?.turn === latestTurn.id && current?.step === (latestStep?.id || undefined)) return true;");
  });

  test("自动下钻跳过空节点、统一承接深链与点选，且 URL 只写到所点层级（2026-09-20）", () => {
    const client = readFileSync("src/components/harness-workbench.tsx", "utf-8");
    const queries = readFileSync("src/lib/db/workbench-queries.ts", "utf-8");

    // 问题 1：自动下钻跳过 0 Turn 的 Thread 与 0 Step 的 Turn（有界回看翻页）。
    expect(client).toContain("const AUTO_DRILL_MAX_EXTRA_PAGES = 2;");
    expect(client).toContain("if (!thread.turnCount) continue;");
    expect(client).toContain("const candidate = turnPage.items.find(turn => turn.stepCount > 0);");
    expect(client).toContain("async function findLatestTurnWithSteps(");
    expect(queries).toContain(
      "SELECT 1 FROM agent_steps latest_path_step",
    );
    expect(queries).toContain("WHERE agent_thread_id = ? AND step_count > 0");

    // 问题 2：挂载深链（如 /export?session= 跳转）由统一下钻 effect 承接，
    // 成功后写回完整规范路径；下钻期间抑制重入，释放后重跑处理新意图。
    expect(client).toContain("const drillInFlightRef = useRef(false);");
    expect(client).toContain("const drillIntentRef = useRef<{ key: string; nonce: number; keepUrl: boolean } | undefined>(undefined);");
    expect(client).toContain("if (drillInFlightRef.current) return;");
    expect(client).toContain("setDrillTick(value => value + 1);");
    expect(client).toContain("if (!ok && !selectionRef.current?.step) setAutoDrillExhausted(scopeKey);");
    // 版本刷新不再重置下钻去重（2026-09-22）：重置会让下钻 effect 在每轮版本刷新
    // 重跑一遍，叠加加载占位造成树闪动；轮询自 2026-09-29 起只静默刷新缓存、
    // 不再直接改写选中，「确认空」范围的新数据由用户点选重新下钻承接。
    expect(client).not.toContain("lastDrillRef.current = { key: \"\", nonce: 0 };");
    // SWR（2026-09-22）：树节点已有 Turn/子 Thread 内容的刷新不再显示加载占位，
    // 占位只在首次加载（尚无内容）时出现——活跃会话 2~5s 涓流更新期间防闪动。
    const threadTree = readFileSync("src/components/workbench/thread-tree.tsx", "utf-8");
    expect(threadTree).toContain("node.turnsLoading && !node.turnPage?.items.length");
    expect(threadTree).toContain("node.childrenLoading && children.length === 0");

    // 问题 3：点选上层节点 URL 只写到所点层级（下钻只更新内存，keepUrl）。
    expect(client).toContain(
      'drillIntentRef.current = { key: `${sessionId}|`, nonce: autoDrillNonceRef.current, keepUrl: true };',
    );
    expect(client).toContain("replaceSelection(base, \"thread\");\n    autoDrillNonceRef.current += 1;");
    // 点 Turn：URL 一次性写到 Turn 层级（不携带 step），补选的最新 Step 只更新内存。
    expect(client).toContain("replaceSelection(base, \"turn\");\n    void (async () => {");
    expect(client).not.toContain("replaceSelection({ ...base, step: latestStep.id }, \"turn\");");
    // 再次点击已选且展开的 Session 仅折叠，不重置内存选中（否则中栏空转）。
    expect(client).toContain("if (alreadySelected && !opening) {");

    // 空态诚实化：下钻确认无数据后不再永久显示「正在自动选择…」。
    expect(client).toContain("该 Session 暂无 Turn / Step 数据");
    expect(client).toContain("该 Thread 暂无 Step 数据");
    expect(client).toContain("const [autoDrillExhausted, setAutoDrillExhausted] = useState(\"\");");
  });
});
