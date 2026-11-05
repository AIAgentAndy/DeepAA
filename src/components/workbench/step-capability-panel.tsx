"use client";

/**
 * P1-3（2026-11-03，2026-11-04 审计修订）：会话 Step「本次传递的能力及使用」面板。
 * - compact（响应页签）：清单来源 = 该响应对应的请求输入，调用 = 本次响应/执行证据；
 *   条目组直接可见且可点反查（闭环起点在面板内，不再要求用户切页签）。
 * - request（请求页签）：输入清单视角（声明工具 + Skills 名单 + 参考标注），
 *   同一契约同一次拉取，不产生第二套数字。
 * 数字全部来自 view=capability-summary / capability-items（P1-2）；能力清单页签
 * 消费既有全量契约（口径同源）。面板不是上游响应的一部分（复制/下载 Raw 不含它）。
 */

import type { StepCapabilitiesState } from "./use-step-capabilities";
import type { StepCapabilityItem } from "@/lib/agent-harness/contracts";

const COMPACT_GROUP_LIMIT = 8;

export function StepCapabilityPanel({state, variant, onOpenCapability}: {
  state: StepCapabilitiesState & {reload: () => void};
  variant: "compact" | "request" | "full";
  /** 审计修订：面板内条目反查入口（闭环起点）。 */
  onOpenCapability?: (kind: "tool" | "skill", name: string) => void;
}) {
  const loading = state.phase === "loading";
  if (loading) {
    return (
      <section className="step-caps-panel" data-variant={variant}>
        <div className="derived-status-banner building" role="status">正在读取本步能力事实…</div>
      </section>
    );
  }
  if (state.phase === "error") {
    return (
      <section className="step-caps-panel" data-variant={variant}>
        <div className="derived-status-banner building" role="status">
          能力事实读取失败（{state.message}）·{" "}
          <button type="button" className="comp-link" onClick={state.reload}>重试</button>
        </div>
      </section>
    );
  }
  const {data} = state;
  const summary = data.summary;
  if (!summary) {
    return (
      <section className="step-caps-panel" data-variant={variant}>
        <div className="derived-status-banner building" role="status">本步暂无能力事实记录。</div>
      </section>
    );
  }

  const coverageNote = buildCoverageNote(summary);  // summary 已非空(上方判过)
  const callsLimitedStep = summary.callsLimited?.step === true;
  return (
    <section className="step-caps-panel" data-variant={variant} aria-label={variant === "request" ? "本次请求输入的能力清单" : "本次传递的能力及使用"}>
      <div className="step-caps-head">
        <b>{variant === "request" ? "本次请求输入的能力清单" : "本次传递的能力及使用"}</b>
        <span className="step-caps-source">
          {summary.agentName || "Agent"}{summary.agentVersion ? ` · v${summary.agentVersion}` : ""}
          {variant === "request" ? " · 本清单即该响应对应请求的输入" : " · 清单来自对应请求，调用来自本次响应"}
        </span>
      </div>
      {coverageNote ? <div className="derived-status-banner building" role="status">{coverageNote}</div> : null}
      {summary.legacyData ? (
        <div className="derived-status-banner building" role="status">升级前数据：清单为旧口径（Tier A 回填），Skills/Rules/构成不可得。</div>
      ) : null}
      {summary.noSnapshot ? (
        <div className="derived-status-banner building" role="status">本步无清单快照（升级前 Step 或未捕获声明）：0 声明不代表没传，仅调用证据如下。</div>
      ) : null}

      <div className="stat-chips">
        {variant !== "request" ? (
          <>
            <div className="schip">
              <div className="n">{summary.invokedToolKinds} <i className="badge-tag">调用</i></div>
              <div className="l">本步调用 {summary.invokedToolCalls} 次{callsLimitedStep ? "（下界，另有未知）" : ""}</div>
            </div>
            <div className="schip">
              <div className="n">{summary.notInvokedDeclaredCount} <i className="badge-tag warn">未调用</i></div>
              <div className="l">{callsLimitedStep ? "声明内未调用（上界，被截断工具可能已调用）" : "声明内本次未调用"}</div>
            </div>
            {summary.observedOnlyCount > 0 ? (
              <div className="schip">
                <div className="n">{summary.observedOnlyCount} <i className="badge-tag warn">未匹配</i></div>
                <div className="l">已调用 · 传递证据未匹配</div>
              </div>
            ) : null}
          </>
        ) : null}
        <div className="schip">
          <div className="n">{summary.declaredToolCount} <i className="badge-tag">声明</i></div>
          <div className="l">{summary.reference ? "参考清单（借补）" : summary.inputComplete === false ? "清单受限" : "请求声明工具"}</div>
        </div>
        <div className="schip">
          <div className="n">{summary.skillCount} <i className="badge-tag warn">Skills</i></div>
          <div className="l">
            {summary.skillsParseStatus === "not_supported" ? "解析未支持" : "目录条目"}
            {summary.activatedSkillCount > 0 ? ` · 本步激活 ${summary.activatedSkillCount}` : ""}
          </div>
        </div>
        {summary.pluginSourceCount > 0 ? (
          <div className="schip">
            <div className="n">{summary.pluginSourceCount} <i className="badge-tag">插件来源</i></div>
            <div className="l">注入名单涉及（推断,不与工具数相加）</div>
          </div>
        ) : null}
        {summary.mcpServerCount > 0 ? (
          <div className="schip">
            <div className="n">{summary.mcpServerCount} <i className="badge-tag">MCP</i></div>
            <div className="l">服务数（叶子见清单）</div>
          </div>
        ) : null}
        {variant !== "request" && summary.turnInvokedCalls > summary.invokedToolCalls ? (
          <div className="schip">
            <div className="n">{summary.turnInvokedCalls} <i className="badge-tag">Turn 累计</i></div>
            <div className="l">截至本步的回合调用{summary.callsLimited?.turn ? "（下界）" : ""}</div>
          </div>
        ) : null}
      </div>

      <CapabilityItemGroup
        title="声明工具"
        items={data.tools?.items}
        limit={COMPACT_GROUP_LIMIT}
        totalCount={summary.declaredToolCount}
        emptyText="本步无声明工具（调用见下方未匹配组）。"
        renderCount={item => item.callsUnknown ? "未知" : item.invoked ? `${item.callsThisStep} 次` : "未调用"}
        onOpenCapability={onOpenCapability ? name => onOpenCapability("tool", name) : undefined}
      />
      {variant !== "request" ? (
        <CapabilityItemGroup
          title="已调用 · 传递证据未匹配"
          items={data.observed?.items}
          limit={COMPACT_GROUP_LIMIT}
          totalCount={summary.observedOnlyCount}
          emptyText="无仅调用证据的工具。"
          renderCount={item => `${item.callsThisStep} 次`}
          onOpenCapability={onOpenCapability ? name => onOpenCapability("tool", name) : undefined}
        />
      ) : null}
      <CapabilityItemGroup
        title="Skills 目录"
        items={data.skills?.items}
        limit={COMPACT_GROUP_LIMIT}
        totalCount={summary.skillCount}
        emptyText={summary.skillsParseStatus === "not_supported" ? "该 Agent 的 Skills 注入格式解析未支持。" : "本步无 Skills 注入名单。"}
        renderCount={item => item.activatedThisStep
          ? `本步激活${item.pluginName ? ` · 插件 ${item.pluginName}（推断）` : ""}`
          : item.pluginName ? `目录 · 插件 ${item.pluginName}（推断）` : "目录"}
        onOpenCapability={onOpenCapability ? name => onOpenCapability("skill", name) : undefined}
      />
      {(data.tools?.hasMore || data.observed?.hasMore || data.skills?.hasMore) ? (
        <p className="step-caps-more">部分分类条目超过 {COMPACT_GROUP_LIMIT} 条，完整分页清单见「能力清单」页签。</p>
      ) : null}
    </section>
  );
}

function CapabilityItemGroup({title, items, limit, totalCount, emptyText, renderCount, onOpenCapability}: {
  title: string;
  items: StepCapabilityItem[] | undefined;
  limit: number;
  totalCount: number;
  emptyText: string;
  renderCount: (item: StepCapabilityItem) => string;
  onOpenCapability?: (name: string) => void;
}) {
  const list = (items ?? []).slice(0, limit);
  const overflow = totalCount - list.length;
  return (
    <div className="step-caps-group">
      <div className="step-caps-group-title">{title} <small className="cnt">{totalCount}</small></div>
      {list.length > 0 ? (
        <div className="step-caps-rows">
          {list.map(item => (
            <div key={`${item.kind}:${item.name}`} className={`step-caps-row${item.invoked ? " on" : ""}`}>
              {onOpenCapability ? (
                <button type="button" className="tname-btn" title="反查该能力的调用与传递记录"
                  onClick={() => onOpenCapability(item.name)}>
                  {item.name}
                </button>
              ) : (
                <span className="tname">{item.name}</span>
              )}
              <span className="num">{renderCount(item)}</span>
            </div>
          ))}
          {overflow > 0 ? <span className="step-caps-overflow">等 {totalCount} 项（见能力清单页签）</span> : null}
        </div>
      ) : <p className="comp-legacy-note">{emptyText}</p>}
    </div>
  );
}

function buildCoverageNote(summary: NonNullable<StepCapabilitiesState & {phase: "ready"}>["data"]["summary"]): string | undefined {
  if (!summary) return undefined;
  const notes: string[] = [];
  if (summary.reference) {
    notes.push(`清单为参考（借补自同 Agent 近期快照${summary.reference.donorSnapshotHash ? ` ${summary.reference.donorSnapshotHash.slice(0, 8)}` : ""}），不作为当次确定传递`);
  }
  if (summary.callsLimited?.step || summary.callsLimited?.turn) {
    notes.push(`调用统计受限（${summary.callsLimited.step ? "本步" : ""}${summary.callsLimited.step && summary.callsLimited.turn ? " / " : ""}${summary.callsLimited.turn ? "本 Turn" : ""}达处理上限），未处理工具显示未知`);
  }
  if (summary.inputComplete === false) {
    notes.push("输入清单 JSON 受限，可能不完整");
  }
  return notes.length > 0 ? notes.join("；") + "。" : undefined;
}
