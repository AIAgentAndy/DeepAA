"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import type { BoundedPage } from "@/lib/db/models";
import type { ScopeType } from "@/lib/db/models";
import type {
  WorkbenchThreadNode,
  WorkbenchTurnSummary,
} from "@/lib/db/workbench-queries";
import { TreeNodeMeta } from "@/components/workbench/tree-node-meta";

const MAX_VISUAL_DEPTH = 4;

export interface ThreadTreeRuntimeNode extends WorkbenchThreadNode {
  childPage?: BoundedPage<WorkbenchThreadNode>;
  turnPage?: BoundedPage<WorkbenchTurnSummary>;
  childrenLoading?: boolean;
  turnsLoading?: boolean;
  childrenError?: string;
  turnsError?: string;
}

export interface ThreadTreeProps {
  roots: WorkbenchThreadNode[];
  expandedIds: ReadonlySet<string>;
  selectedThreadId?: string;
  selectedTurnId?: string;
  activeThreadPathIds?: ReadonlySet<string>;
  selectedScopeType?: ScopeType;
  nowMs?: number;
  onToggle(threadId: string): void;
  onSelectThread(threadId: string): void;
  onSelectTurn(turnId: string): void;
  onLoadMore(threadId: string): void;
  onLoadMoreTurns?(threadId: string): void;
  onRetry?(threadId: string, kind: "children" | "turns"): void;
}

/** 层级 ID 默认保留前 8 位和后 6 位，完整值始终由调用处放入 title。 */
export function compactHierarchicalId(value: string): string {
  if (value.length <= 15) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

/** 同页截断结果碰撞时逐步扩展后缀，直到可区分或展示完整 ID。 */
export function compactHierarchicalIds(values: readonly string[]): Map<string, string> {
  const uniqueValues = [...new Set(values)];
  const labels = new Map(uniqueValues.map(value => [value, compactHierarchicalId(value)]));
  const collisions = collisionGroups(labels);
  for (const group of collisions) {
    let suffixLength = 8;
    while (true) {
      const nextLabels = group.map(value => hierarchicalLabel(value, suffixLength));
      if (new Set(nextLabels).size === nextLabels.length) {
        group.forEach((value, index) => labels.set(value, nextLabels[index]!));
        break;
      }
      if (group.every(value => suffixLength >= value.length - 8)) {
        group.forEach(value => labels.set(value, value));
        break;
      }
      suffixLength += 2;
    }
  }
  return labels;
}

/** 每一级展开状态独立切换；当前选择不会参与折叠判定。 */
export function toggleExpandedId(
  expandedIds: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(expandedIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** 保持纯递归边界，后续分页只向对应父 Thread 追加直接子节点。 */
export function loadChildThreads(node: WorkbenchThreadNode): WorkbenchThreadNode[] {
  return node.children;
}

export function parseThreadPage(value: unknown): BoundedPage<WorkbenchThreadNode> | undefined {
  return parseBoundedPage(value, isThreadNode);
}

export function parseTurnPage(value: unknown): BoundedPage<WorkbenchTurnSummary> | undefined {
  return parseBoundedPage(value, isTurnSummary);
}

/** cursor 翻页按稳定 ID 去重，服务端刷新后的同 ID 摘要覆盖旧值。 */
export function mergeBoundedPage<T extends { id: string }>(
  current: BoundedPage<T>,
  incoming: BoundedPage<T>,
): BoundedPage<T> {
  const merged = new Map(current.items.map(item => [item.id, item]));
  for (const item of incoming.items) merged.set(item.id, item);
  return {
    ...incoming,
    items: [...merged.values()],
    processedCount: current.processedCount + incoming.processedCount,
    limited: incoming.hasMore,
  };
}

/** Map 插入顺序作为轻量 LRU；当前选择即使较旧也必须保留。 */
export function retainRecentPages<T>(
  pages: ReadonlyMap<string, T>,
  protectedId: string | undefined,
  capacity: number,
): Map<string, T> {
  const boundedCapacity = Math.max(1, Math.floor(capacity));
  const retained = new Map(pages);
  for (const id of retained.keys()) {
    if (retained.size <= boundedCapacity) break;
    if (id === protectedId) continue;
    retained.delete(id);
  }
  return retained;
}

export function ThreadTree({
  roots,
  expandedIds,
  selectedThreadId,
  selectedTurnId,
  activeThreadPathIds,
  selectedScopeType,
  nowMs,
  onToggle,
  onSelectThread,
  onSelectTurn,
  onLoadMore,
  onLoadMoreTurns,
  onRetry,
}: ThreadTreeProps) {
  if (roots.length === 0) {
    return <p className="tree-empty-state">该 Session 暂无 Thread</p>;
  }
  const idLabels = compactHierarchicalIds(collectHierarchicalIds(roots));
  return (
    <div className="thread-tree" role="tree" aria-label="Thread 层级">
      {roots.map(root => (
        <ThreadBranch
          key={root.id}
          node={root as ThreadTreeRuntimeNode}
          depth={0}
          expandedIds={expandedIds}
          selectedThreadId={selectedThreadId}
          selectedTurnId={selectedTurnId}
          activeThreadPathIds={activeThreadPathIds}
          selectedScopeType={selectedScopeType}
          nowMs={nowMs}
          onToggle={onToggle}
          onSelectThread={onSelectThread}
          onSelectTurn={onSelectTurn}
          onLoadMore={onLoadMore}
          onLoadMoreTurns={onLoadMoreTurns}
          onRetry={onRetry}
          idLabels={idLabels}
        />
      ))}
    </div>
  );
}

interface ThreadBranchProps extends Omit<ThreadTreeProps, "roots"> {
  node: ThreadTreeRuntimeNode;
  depth: number;
  idLabels: ReadonlyMap<string, string>;
}

function ThreadBranch({
  node,
  depth,
  expandedIds,
  selectedThreadId,
  selectedTurnId,
  activeThreadPathIds,
  selectedScopeType,
  nowMs,
  onToggle,
  onSelectThread,
  onSelectTurn,
  onLoadMore,
  onLoadMoreTurns,
  onRetry,
  idLabels,
}: ThreadBranchProps) {
  const expanded = expandedIds.has(node.id);
  const children = loadChildThreads(node) as ThreadTreeRuntimeNode[];
  const hasExpandableContent = node.childCount > 0 || node.turnCount > 0;
  const visualDepth = Math.min(depth, MAX_VISUAL_DEPTH);
  const inActivePath = activeThreadPathIds?.has(node.id) === true;
  const isCurrentThread = selectedThreadId === node.id
    && selectedScopeType === "thread";
  const threadStateClass = isCurrentThread
    ? " selected-scope"
    : inActivePath ? " path-ancestor" : "";
  const fullTitle = [
    `内部 Thread: ${node.id}`,
    node.externalThreadId ? `外部 Thread: ${node.externalThreadId}` : "",
    node.parentAgentThreadId ? `父 Thread: ${node.parentAgentThreadId}` : "",
  ].filter(Boolean).join("\n");

  return (
    <div
      className="thread-branch"
      role="treeitem"
      aria-expanded={hasExpandableContent ? expanded : undefined}
      data-thread-depth={depth}
      data-visual-depth={visualDepth}
      style={{ "--thread-depth": visualDepth } as React.CSSProperties}
    >
      <div className={`tree-row tree-thread${threadStateClass}`} data-tree-level="thread">
        <button
          type="button"
          className="tree-chevron-button"
          data-thread-chevron={node.id}
          aria-expanded={expanded}
          aria-label={`${expanded ? "折叠" : "展开"} Thread ${node.displayName}`}
          disabled={!hasExpandableContent && !expanded}
          onClick={event => {
            event.stopPropagation();
            onToggle(node.id);
          }}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <button
          type="button"
          className="tree-row-main"
          title={fullTitle}
          aria-current={isCurrentThread ? "true" : undefined}
          onClick={() => onSelectThread(node.id)}
        >
          <span className="tree-dot" aria-hidden="true" />
          <span className="tree-label">
            <span className="tree-primary-label">{node.displayName}</span>
            <span className="tree-label-sep" aria-hidden="true">·</span>
            <span className="tree-secondary-label">{idLabels.get(node.id) || compactHierarchicalId(node.id)}</span>
          </span>
          <TreeNodeMeta countLabel={`${node.turnCount} turn`} endTime={node.endTime} nowMs={nowMs} />
        </button>
      </div>

      {expanded ? (
        <div className="tree-children tree-children-thread" role="group">
          {/* SWR（2026-09-22）：已有 Turn 内容的刷新不再显示加载占位——活跃会话期间
              版本轮询每 2~5s 触发跟随刷新，占位行反复增删会造成整栏布局闪动；
              占位只在首次加载（尚无内容）时出现。 */}
          {node.turnsLoading && !node.turnPage?.items.length ? <TreeStatus text="正在加载 Turn…" /> : null}
          {node.turnsError ? (
            <TreeError
              message={node.turnsError}
              onRetry={onRetry ? () => onRetry(node.id, "turns") : undefined}
            />
          ) : null}
          {node.turnPage?.items.map(turn => {
            const isSelectedTurn = selectedTurnId === turn.id;
            // step 视图下也把所属 Turn 行视为当前选中行，避免树中“没有选中行”；
            // 点击 Turn 行仍切换为 turn 范围。
            const isCurrentTurn = isSelectedTurn
              && (selectedScopeType === "turn" || selectedScopeType === "step");
            const turnStateClass = isCurrentTurn
              ? " selected-scope"
              : isSelectedTurn ? " path-ancestor" : "";
            return (
              <button
                key={turn.id}
                type="button"
                className={`tree-row tree-turn${turnStateClass}`}
                data-tree-level="turn"
                title={turn.id}
                aria-current={isCurrentTurn ? "true" : undefined}
                onClick={() => onSelectTurn(turn.id)}
              >
                <span className="tree-dot" aria-hidden="true" />
                <span className="tree-label">Turn · {idLabels.get(turn.id) || compactHierarchicalId(turn.id)}</span>
                <TreeNodeMeta countLabel={`${turn.stepCount} step`} endTime={turn.endTime} nowMs={nowMs} />
              </button>
            );
          })}
          {node.turnPage?.hasMore ? (
            <button
              type="button"
              className="tree-load-more"
              onClick={() => onLoadMoreTurns?.(node.id)}
            >
              加载更多 Turn
            </button>
          ) : null}

          {node.childrenLoading && children.length === 0 ? <TreeStatus text="正在加载子 Thread…" /> : null}
          {node.childrenError ? (
            <TreeError
              message={node.childrenError}
              onRetry={onRetry ? () => onRetry(node.id, "children") : undefined}
            />
          ) : null}
          {children.map(child => (
            <ThreadBranch
              key={child.id}
              node={child}
              depth={depth + 1}
              expandedIds={expandedIds}
              selectedThreadId={selectedThreadId}
              selectedTurnId={selectedTurnId}
              activeThreadPathIds={activeThreadPathIds}
              selectedScopeType={selectedScopeType}
              onToggle={onToggle}
              onSelectThread={onSelectThread}
              onSelectTurn={onSelectTurn}
              onLoadMore={onLoadMore}
              onLoadMoreTurns={onLoadMoreTurns}
              onRetry={onRetry}
              idLabels={idLabels}
            />
          ))}
          {node.childPage?.hasMore ? (
            <button
              type="button"
              className="tree-load-more"
              onClick={() => onLoadMore(node.id)}
            >
              加载更多子 Thread
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TreeStatus({ text }: { text: string }) {
  return <p className="tree-inline-status" role="status">{text}</p>;
}

function TreeError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="tree-inline-error" role="alert">
      <span>{message}</span>
      {onRetry ? <button type="button" onClick={onRetry}>重试</button> : null}
    </div>
  );
}

function parseBoundedPage<T>(
  value: unknown,
  isItem: (item: unknown) => item is T,
): BoundedPage<T> | undefined {
  const record = objectRecord(value);
  if (
    !record
    || !Array.isArray(record.items)
    || !record.items.every(isItem)
    || !nonNegativeInteger(record.candidateCount)
    || !nonNegativeInteger(record.processedCount)
    || typeof record.limited !== "boolean"
    || typeof record.hasMore !== "boolean"
    || !optionalString(record.nextCursor)
    || !nonNegativeInteger(record.dataVersion)
    || !isWorkerStatus(record.derivedStatus)
  ) {
    return undefined;
  }
  return record as unknown as BoundedPage<T>;
}

function isThreadNode(value: unknown): value is WorkbenchThreadNode {
  const record = objectRecord(value);
  return !!record
    && nonEmptyString(record.id)
    && nonEmptyString(record.agentSessionId)
    && optionalString(record.parentAgentThreadId)
    && optionalString(record.externalThreadId)
    && optionalString(record.externalAgentId)
    && nonEmptyString(record.displayName)
    && typeof record.isRoot === "boolean"
    && typeof record.isPlaceholder === "boolean"
    && nonEmptyString(record.startTime)
    && nonEmptyString(record.endTime)
    && nonNegativeInteger(record.requestCount)
    && nonNegativeInteger(record.turnCount)
    && nonNegativeInteger(record.childCount)
    && Array.isArray(record.children)
    && record.children.every(isThreadNode);
}

function isTurnSummary(value: unknown): value is WorkbenchTurnSummary {
  const record = objectRecord(value);
  return !!record
    && nonEmptyString(record.id)
    && nonEmptyString(record.agentSessionId)
    && nonEmptyString(record.agentThreadId)
    && optionalString(record.nativeTurnId)
    && nonEmptyString(record.startTime)
    && nonEmptyString(record.endTime)
    && nonNegativeInteger(record.stepCount)
    && nonNegativeInteger(record.auxiliaryRequestCount);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || nonEmptyString(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isWorkerStatus(value: unknown): boolean {
  return value === "idle" || value === "running" || value === "paused_disk" || value === "failed";
}

function collectHierarchicalIds(nodes: WorkbenchThreadNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes as ThreadTreeRuntimeNode[]) {
    ids.push(node.id);
    ids.push(...(node.turnPage?.items.map(turn => turn.id) || []));
    ids.push(...collectHierarchicalIds(node.children));
  }
  return ids;
}

function collisionGroups(labels: ReadonlyMap<string, string>): string[][] {
  const byLabel = new Map<string, string[]>();
  for (const [value, label] of labels) {
    const group = byLabel.get(label) || [];
    group.push(value);
    byLabel.set(label, group);
  }
  return [...byLabel.values()].filter(group => group.length > 1);
}

function hierarchicalLabel(value: string, suffixLength: number): string {
  if (value.length <= 8 + suffixLength + 1) return value;
  return `${value.slice(0, 8)}…${value.slice(-suffixLength)}`;
}
