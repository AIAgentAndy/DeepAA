import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import type { ResolvedAgentPath } from "../db/models";

export interface UpsertAgentPathOptions {
  model?: string;
  exchangeId?: string;
  sourceId?: number;
}

export interface UpsertAgentPathResult {
  sessionId: string;
  threadId: string;
  rootThreadId: string;
}

interface CanonicalPathResolution {
  path: ResolvedAgentPath;
  isolatedCurrent: boolean;
}

interface SessionRootResolution {
  canonicalRootThreadId?: string;
  isolatedThreadIds: Set<string>;
}

interface ActualPathProfile {
  maxDepth: number;
  cycle: boolean;
  containsTarget: boolean;
  containsOtherRoot: boolean;
}

type FallbackOutcome =
  | "attached-root"
  | "kept-existing-parent"
  | "isolated";

interface ParentFallbackResolution {
  parentThreadId?: string;
  outcome: FallbackOutcome;
}

/**
 * 在调用方事务内同步持久化单条已解析路径；函数自身不持有跨调用缓存。
 */
export function upsertAgentPath(
  db: DeepaaDatabase,
  path: ResolvedAgentPath,
  timestamp: string,
  options?: UpsertAgentPathOptions,
): UpsertAgentPathResult {
  db.prepare(
    `INSERT INTO agent_sessions(
      id, target_id, target_name, agent_fingerprint_id, agent_name,
      external_session_id, external_conversation_id, source, confidence,
      start_time, end_time
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      target_id = excluded.target_id,
      target_name = excluded.target_name,
      agent_fingerprint_id = excluded.agent_fingerprint_id,
      agent_name = excluded.agent_name,
      external_session_id = COALESCE(
        excluded.external_session_id, agent_sessions.external_session_id
      ),
      external_conversation_id = COALESCE(
        excluded.external_conversation_id,
        agent_sessions.external_conversation_id
      ),
      source = excluded.source,
      confidence = excluded.confidence,
      start_time = MIN(agent_sessions.start_time, excluded.start_time),
      end_time = MAX(agent_sessions.end_time, excluded.end_time)`,
  ).run(
    path.agentSessionId,
    path.targetId,
    path.targetName,
    path.agentFingerprintId,
    path.agentName,
    path.externalSessionId ?? null,
    path.externalConversationId ?? null,
    path.sessionSource,
    path.confidence,
    timestamp,
    timestamp,
  );
  mergeModelSet(db, "agent_sessions", path.agentSessionId, options?.model);
  writePathDiagnostics(db, path, timestamp, options);

  const canonicalResolution = resolveCanonicalRootPath(
    db,
    path,
    timestamp,
    options,
  );
  const canonicalPath = canonicalResolution.path;
  if (canonicalResolution.isolatedCurrent) {
    insertCurrentThread(db, canonicalPath, timestamp);
    mergeModelSet(
      db,
      "agent_threads",
      canonicalPath.agentThreadId,
      options?.model,
    );
    db.prepare(
      `UPDATE agent_threads
       SET is_root = 0, parent_agent_thread_id = NULL
       WHERE id = ?`,
    ).run(canonicalPath.agentThreadId);
    insertSelfClosure(db, canonicalPath.agentThreadId);
    return writeResult(canonicalPath);
  }
  if (
    canonicalPath.rootAgentThreadId !== path.rootAgentThreadId
    && canonicalPath.agentThreadId === canonicalPath.rootAgentThreadId
  ) {
    return writeResult(canonicalPath);
  }
  const parentThreadId = canonicalPath.parentAgentThreadId
    ?? (canonicalPath.agentThreadId === canonicalPath.rootAgentThreadId
      ? undefined
      : canonicalPath.rootAgentThreadId);
  insertPlaceholderThread(
    db,
    canonicalPath.agentSessionId,
    canonicalPath.rootAgentThreadId,
    true,
    timestamp,
  );
  if (
    parentThreadId
    && canonicalPath.agentThreadId !== canonicalPath.rootAgentThreadId
    && parentThreadId !== canonicalPath.rootAgentThreadId
    && parentThreadId !== canonicalPath.agentThreadId
    && !threadRow(db, parentThreadId)
  ) {
    insertPlaceholderThread(
      db,
      canonicalPath.agentSessionId,
      parentThreadId,
      false,
      timestamp,
    );
  }
  insertCurrentThread(db, canonicalPath, timestamp);
  mergeModelSet(
    db,
    "agent_threads",
    canonicalPath.agentThreadId,
    options?.model,
  );
  insertSelfClosure(db, canonicalPath.rootAgentThreadId);
  if (parentThreadId && threadRow(db, parentThreadId)) {
    insertSelfClosure(db, parentThreadId);
  }
  insertSelfClosure(db, canonicalPath.agentThreadId);

  const effectiveParentThreadId = resolveParentThreadId(
    db,
    canonicalPath,
    parentThreadId,
    timestamp,
    options,
  );
  if (!effectiveParentThreadId) return writeResult(canonicalPath);

  db.prepare(
    `UPDATE agent_threads
     SET parent_agent_thread_id = ?
     WHERE id = ? AND parent_agent_thread_id IS NULL`,
  ).run(effectiveParentThreadId, canonicalPath.agentThreadId);
  insertTransitiveClosure(
    db,
    effectiveParentThreadId,
    canonicalPath.agentThreadId,
  );
  return writeResult(canonicalPath);
}

function writeResult(path: ResolvedAgentPath): UpsertAgentPathResult {
  return {
    sessionId: path.agentSessionId,
    threadId: path.agentThreadId,
    rootThreadId: path.rootAgentThreadId,
  };
}

function writePathDiagnostics(
  db: DeepaaDatabase,
  path: ResolvedAgentPath,
  timestamp: string,
  options: UpsertAgentPathOptions | undefined,
): void {
  const detailsJson = JSON.stringify({
    origin: "thread-identity",
    session: path.agentSessionId,
    current: path.agentThreadId,
    parent: path.parentAgentThreadId ?? null,
    root: path.rootAgentThreadId,
  });
  for (const diagnostic of path.diagnostics) {
    insertDiagnostic(
      db,
      diagnostic.code,
      diagnostic.message,
      detailsJson,
      timestamp,
      options,
    );
  }
}

/**
 * 在任何 Thread 写入前锁定 Session canonical root；脏库按 ID 稳定选择且不扩增根数。
 */
function resolveCanonicalRootPath(
  db: DeepaaDatabase,
  path: ResolvedAgentPath,
  timestamp: string,
  options: UpsertAgentPathOptions | undefined,
): CanonicalPathResolution {
  const rootResolution = reconcileSessionRoots(
    db,
    path,
    timestamp,
    options,
  );
  const existingRootThreadId = rootResolution.canonicalRootThreadId;
  if (!existingRootThreadId) {
    return { path, isolatedCurrent: false };
  }
  const isolatedCurrent = rootResolution.isolatedThreadIds.has(
    path.agentThreadId,
  );
  if (existingRootThreadId === path.rootAgentThreadId) {
    return { path, isolatedCurrent };
  }

  const canonicalPath = {
    ...path,
    rootAgentThreadId: existingRootThreadId,
    parentAgentThreadId: path.parentAgentThreadId === path.rootAgentThreadId
      ? existingRootThreadId
      : path.parentAgentThreadId,
  };
  if (!isolatedCurrent) {
    writeRootConflictDiagnostic(
      db,
      path,
      existingRootThreadId,
      timestamp,
      options,
    );
  }
  return { path: canonicalPath, isolatedCurrent };
}

function reconcileSessionRoots(
  db: DeepaaDatabase,
  path: ResolvedAgentPath,
  timestamp: string,
  options: UpsertAgentPathOptions | undefined,
): SessionRootResolution {
  let topRootThreadId: string | undefined;
  const roots = db.prepare(
    `SELECT id FROM agent_threads
     WHERE agent_session_id = ? AND is_root = 1
     ORDER BY id ASC`,
  ).pluck();
  for (const rootThreadId of roots.iterate(path.agentSessionId) as Iterable<
    string
  >) {
    if (!actualAncestorProfile(
      db,
      path.agentSessionId,
      rootThreadId,
    ).containsOtherRoot) {
      topRootThreadId = rootThreadId;
      break;
    }
  }
  const fallbackRootThreadId = db.prepare(
    `SELECT id FROM agent_threads
     WHERE agent_session_id = ? AND is_root = 1
     ORDER BY id ASC
     LIMIT 1`,
  ).pluck().get(path.agentSessionId) as string | undefined;
  const canonicalRootThreadId = topRootThreadId ?? fallbackRootThreadId;
  const isolatedThreadIds = new Set<string>();
  if (!canonicalRootThreadId) {
    return { canonicalRootThreadId: undefined, isolatedThreadIds };
  }

  const firstExtraRoot = db.prepare(
    `SELECT id, parent_agent_thread_id
     FROM agent_threads
     WHERE agent_session_id = ? AND is_root = 1 AND id <> ?
     ORDER BY id ASC
     LIMIT 1`,
  );
  const nextExtraRoot = db.prepare(
    `SELECT id, parent_agent_thread_id
     FROM agent_threads
     WHERE agent_session_id = ? AND is_root = 1 AND id <> ? AND id > ?
     ORDER BY id ASC
     LIMIT 1`,
  );
  let reconciled = false;
  let extraRoot = firstExtraRoot.get(
    path.agentSessionId,
    canonicalRootThreadId,
  ) as { id: string; parent_agent_thread_id: string | null } | undefined;
  while (extraRoot) {
    const isolated = reconcileExtraRoot(
      db,
      path,
      canonicalRootThreadId,
      extraRoot,
      timestamp,
      options,
    );
    reconciled = true;
    if (isolated) isolatedThreadIds.add(extraRoot.id);
    extraRoot = nextExtraRoot.get(
      path.agentSessionId,
      canonicalRootThreadId,
      extraRoot.id,
    ) as { id: string; parent_agent_thread_id: string | null } | undefined;
  }
  if (reconciled) {
    db.prepare(
      `UPDATE agent_threads
       SET is_root = 1, parent_agent_thread_id = NULL
       WHERE id = ?`,
    ).run(canonicalRootThreadId);
    rebuildSessionClosure(db, path.agentSessionId);
  }
  return { canonicalRootThreadId, isolatedThreadIds };
}

function reconcileExtraRoot(
  db: DeepaaDatabase,
  path: ResolvedAgentPath,
  canonicalRootThreadId: string,
  extraRoot: { id: string; parent_agent_thread_id: string | null },
  timestamp: string,
  options: UpsertAgentPathOptions | undefined,
): boolean {
  const canonicalProfile = actualAncestorProfile(
    db,
    path.agentSessionId,
    canonicalRootThreadId,
  );
  const extraProfile = actualDescendantProfile(
    db,
    path.agentSessionId,
    extraRoot.id,
    canonicalRootThreadId,
  );
  const wouldCycle = canonicalProfile.cycle
    || extraProfile.cycle
    || extraProfile.containsTarget;
  const hasConflictingParent = extraRoot.parent_agent_thread_id !== null
    && extraRoot.parent_agent_thread_id !== canonicalRootThreadId;
  const exceedsDepth = canonicalProfile.maxDepth + extraProfile.maxDepth + 1
    > 32;
  if (wouldCycle || hasConflictingParent || exceedsDepth) {
    db.prepare(
      `UPDATE agent_threads
       SET is_root = 0, parent_agent_thread_id = NULL
       WHERE id = ?`,
    ).run(extraRoot.id);
    writeRootReconciliationDiagnostic(
      db,
      "thread-root-reconcile-failed",
      "脏 extra root 无法安全挂载，已降级并隔离。",
      path,
      canonicalRootThreadId,
      extraRoot.id,
      wouldCycle ? "cycle" : hasConflictingParent ? "parent-conflict" : "max-depth",
      timestamp,
      options,
    );
    return true;
  }

  db.prepare(
    `UPDATE agent_threads
     SET is_root = 0, parent_agent_thread_id = ?
     WHERE id = ?`,
  ).run(canonicalRootThreadId, extraRoot.id);
  writeRootReconciliationDiagnostic(
    db,
    "thread-root-reconciled",
    "脏 extra root 已降级并挂到 Session canonical root。",
    path,
    canonicalRootThreadId,
    extraRoot.id,
    "attached",
    timestamp,
    options,
  );
  return false;
}

/**
 * 多根修复只在当前 Session 内重建 closure，以真实 parent 邻接关系清除脏传递边。
 */
function rebuildSessionClosure(
  db: DeepaaDatabase,
  sessionId: string,
): void {
  db.prepare(
    `DELETE FROM thread_closure
     WHERE depth > 0 AND ancestor_thread_id IN (
       SELECT id FROM agent_threads WHERE agent_session_id = ?
     )`,
  ).run(sessionId);
  db.prepare(
    `DELETE FROM thread_closure
     WHERE depth > 0 AND descendant_thread_id IN (
       SELECT id FROM agent_threads WHERE agent_session_id = ?
     )`,
  ).run(sessionId);
  db.prepare(
    `WITH RECURSIVE actual_paths(
       ancestor_thread_id, descendant_thread_id, depth, visited, cycle
     ) AS (
       SELECT id, id, 0, ',' || hex(id) || ',', 0
       FROM agent_threads
       WHERE agent_session_id = ?
       UNION ALL
       SELECT path.ancestor_thread_id, child.id, path.depth + 1,
              path.visited || hex(child.id) || ',',
              CASE
                WHEN instr(path.visited, ',' || hex(child.id) || ',') > 0
                THEN 1 ELSE 0
              END
       FROM actual_paths AS path
       JOIN agent_threads AS child
         ON child.agent_session_id = ?
        AND child.parent_agent_thread_id = path.descendant_thread_id
       WHERE path.depth < 32 AND path.cycle = 0
     )
     INSERT INTO thread_closure(
       ancestor_thread_id, descendant_thread_id, depth
     )
     SELECT ancestor_thread_id, descendant_thread_id, MIN(depth)
     FROM actual_paths
     WHERE cycle = 0
     GROUP BY ancestor_thread_id, descendant_thread_id
     ON CONFLICT(ancestor_thread_id, descendant_thread_id)
     DO UPDATE SET depth = excluded.depth`,
  ).run(sessionId, sessionId);
}

/** 向上额外探测到第 33 层；hex visited 对任意内部文本 ID 都能稳定识别循环。 */
function actualAncestorProfile(
  db: DeepaaDatabase,
  sessionId: string,
  threadId: string,
  targetThreadId?: string,
): ActualPathProfile {
  const row = db.prepare(
    `WITH RECURSIVE ancestors(id, depth, visited, cycle) AS (
       SELECT id, 0, ',' || hex(id) || ',', 0
       FROM agent_threads
       WHERE id = ? AND agent_session_id = ?
       UNION ALL
       SELECT parent.id, ancestor.depth + 1,
              ancestor.visited || hex(parent.id) || ',',
              CASE
                WHEN instr(ancestor.visited, ',' || hex(parent.id) || ',') > 0
                THEN 1 ELSE 0
              END
       FROM ancestors AS ancestor
       JOIN agent_threads AS current ON current.id = ancestor.id
       JOIN agent_threads AS parent
         ON parent.id = current.parent_agent_thread_id
        AND parent.agent_session_id = ?
       WHERE ancestor.depth < 33 AND ancestor.cycle = 0
     )
     SELECT COALESCE(MAX(ancestor.depth), 0) AS max_depth,
            COALESCE(MAX(ancestor.cycle), 0) AS cycle,
            COALESCE(MAX(
              CASE WHEN ancestor.depth > 0 AND ancestor.id IS ? THEN 1 ELSE 0 END
            ), 0) AS contains_target,
            COALESCE(MAX(
              CASE
                WHEN ancestor.depth > 0 AND root.is_root = 1
                  AND ancestor.id <> ?
                THEN 1 ELSE 0
              END
            ), 0) AS contains_other_root
     FROM ancestors AS ancestor
     LEFT JOIN agent_threads AS root ON root.id = ancestor.id`,
  ).get(
    threadId,
    sessionId,
    sessionId,
    targetThreadId ?? null,
    threadId,
  ) as {
    max_depth: number;
    cycle: number;
    contains_target: number;
    contains_other_root: number;
  };
  return {
    maxDepth: row.max_depth,
    cycle: row.cycle === 1,
    containsTarget: row.contains_target === 1,
    containsOtherRoot: row.contains_other_root === 1,
  };
}

/** 向下只扫描当前 Session 的真实子关系，并以第 33 层作为超限哨兵。 */
function actualDescendantProfile(
  db: DeepaaDatabase,
  sessionId: string,
  threadId: string,
  targetThreadId?: string,
): ActualPathProfile {
  const row = db.prepare(
    `WITH RECURSIVE descendants(id, depth, visited, cycle) AS (
       SELECT id, 0, ',' || hex(id) || ',', 0
       FROM agent_threads
       WHERE id = ? AND agent_session_id = ?
       UNION ALL
       SELECT child.id, descendant.depth + 1,
              descendant.visited || hex(child.id) || ',',
              CASE
                WHEN instr(descendant.visited, ',' || hex(child.id) || ',') > 0
                THEN 1 ELSE 0
              END
       FROM descendants AS descendant
       JOIN agent_threads AS child
         ON child.agent_session_id = ?
        AND child.parent_agent_thread_id = descendant.id
       WHERE descendant.depth < 33 AND descendant.cycle = 0
     )
     SELECT COALESCE(MAX(depth), 0) AS max_depth,
            COALESCE(MAX(cycle), 0) AS cycle,
            COALESCE(MAX(
              CASE WHEN depth > 0 AND id IS ? THEN 1 ELSE 0 END
            ), 0) AS contains_target
     FROM descendants`,
  ).get(
    threadId,
    sessionId,
    sessionId,
    targetThreadId ?? null,
  ) as {
    max_depth: number;
    cycle: number;
    contains_target: number;
  };
  return {
    maxDepth: row.max_depth,
    cycle: row.cycle === 1,
    containsTarget: row.contains_target === 1,
    containsOtherRoot: false,
  };
}

function writeRootReconciliationDiagnostic(
  db: DeepaaDatabase,
  code: string,
  message: string,
  path: ResolvedAgentPath,
  canonicalRootThreadId: string,
  extraRootThreadId: string,
  result: string,
  timestamp: string,
  options: UpsertAgentPathOptions | undefined,
): void {
  const detailsJson = JSON.stringify({
    origin: "hierarchy-repository",
    session: path.agentSessionId,
    current: path.agentThreadId,
    parent: canonicalRootThreadId,
    root: canonicalRootThreadId,
    extra: extraRootThreadId,
    result,
  });
  insertDiagnostic(db, code, message, detailsJson, timestamp, options);
}

function writeRootConflictDiagnostic(
  db: DeepaaDatabase,
  path: ResolvedAgentPath,
  existingRootThreadId: string,
  timestamp: string,
  options: UpsertAgentPathOptions | undefined,
): void {
  const detailsJson = JSON.stringify({
    origin: "hierarchy-repository",
    session: path.agentSessionId,
    current: path.agentThreadId,
    parent: existingRootThreadId,
    root: existingRootThreadId,
    requested: path.rootAgentThreadId,
    existing: existingRootThreadId,
  });
  insertDiagnostic(
    db,
    "thread-root-conflict",
    "Session 已存在 canonical root，后到的不同根身份已降级为普通 Thread。",
    detailsJson,
    timestamp,
    options,
  );
}

/** 一次连接父的全部祖先与当前节点的全部后代，支持占位父晚到后补齐整棵子树。 */
function insertTransitiveClosure(
  db: DeepaaDatabase,
  parentThreadId: string,
  currentThreadId: string,
): void {
  db.prepare(
    `INSERT INTO thread_closure(
      ancestor_thread_id, descendant_thread_id, depth
    )
    SELECT parent.ancestor_thread_id, child.descendant_thread_id,
           parent.depth + child.depth + 1
    FROM thread_closure AS parent
    CROSS JOIN thread_closure AS child
    WHERE parent.descendant_thread_id = ?
      AND child.ancestor_thread_id = ?
    ON CONFLICT(ancestor_thread_id, descendant_thread_id)
    DO UPDATE SET depth = MIN(thread_closure.depth, excluded.depth)`,
  ).run(parentThreadId, currentThreadId);
}

function insertPlaceholderThread(
  db: DeepaaDatabase,
  sessionId: string,
  threadId: string,
  isRoot: boolean,
  timestamp: string,
): void {
  db.prepare(
    `INSERT INTO agent_threads(
      id, agent_session_id, source, display_name, confidence, is_root,
      is_placeholder, start_time, end_time
    ) VALUES(?, ?, 'placeholder', ?, 'low', ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      start_time = MIN(agent_threads.start_time, excluded.start_time),
      end_time = MAX(agent_threads.end_time, excluded.end_time)
    WHERE agent_threads.agent_session_id = excluded.agent_session_id
      AND agent_threads.is_placeholder = 1`,
  ).run(
    threadId,
    sessionId,
    isRoot ? "根 Thread（占位）" : "父 Thread（占位）",
    isRoot ? 1 : 0,
    timestamp,
    timestamp,
  );
}

function insertCurrentThread(
  db: DeepaaDatabase,
  path: ResolvedAgentPath,
  timestamp: string,
): void {
  db.prepare(
    `INSERT INTO agent_threads(
      id, agent_session_id, external_thread_id, external_agent_id,
      external_parent_thread_id, external_parent_agent_id, source,
      display_name, confidence, is_root, is_placeholder, start_time, end_time
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      external_thread_id = COALESCE(
        agent_threads.external_thread_id, excluded.external_thread_id
      ),
      external_agent_id = COALESCE(
        agent_threads.external_agent_id, excluded.external_agent_id
      ),
      external_parent_thread_id = COALESCE(
        agent_threads.external_parent_thread_id,
        excluded.external_parent_thread_id
      ),
      external_parent_agent_id = COALESCE(
        agent_threads.external_parent_agent_id,
        excluded.external_parent_agent_id
      ),
      source = excluded.source,
      display_name = excluded.display_name,
      confidence = excluded.confidence,
      is_root = excluded.is_root,
      is_placeholder = 0,
      start_time = MIN(agent_threads.start_time, excluded.start_time),
      end_time = MAX(agent_threads.end_time, excluded.end_time)`,
  ).run(
    path.agentThreadId,
    path.agentSessionId,
    path.externalThreadId ?? null,
    path.externalAgentId ?? null,
    path.externalParentThreadId ?? null,
    path.externalParentAgentId ?? null,
    path.threadSource,
    path.displayName,
    path.confidence,
    path.agentThreadId === path.rootAgentThreadId ? 1 : 0,
    timestamp,
    timestamp,
  );
}

function insertSelfClosure(db: DeepaaDatabase, threadId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO thread_closure(
      ancestor_thread_id, descendant_thread_id, depth
    ) VALUES(?, ?, 0)`,
  ).run(threadId, threadId);
}

function mergeModelSet(
  db: DeepaaDatabase,
  table: "agent_sessions" | "agent_threads",
  id: string,
  model: string | undefined,
): void {
  const normalizedModel = model?.trim();
  if (!normalizedModel) return;

  const rawModelSet = db.prepare(
    `SELECT model_set_json FROM ${table} WHERE id = ?`,
  ).pluck().get(id) as string;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawModelSet);
  } catch {
    parsed = [];
  }
  const models = Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
  const modelSetJson = JSON.stringify(
    [...new Set([...models, normalizedModel])].sort(),
  );
  db.prepare(
    `UPDATE ${table} SET model_set_json = ? WHERE id = ?`,
  ).run(modelSetJson, id);
}

interface ThreadRow {
  agent_session_id: string;
  parent_agent_thread_id: string | null;
}

function threadRow(
  db: DeepaaDatabase,
  threadId: string,
): ThreadRow | undefined {
  return db.prepare(
    `SELECT agent_session_id, parent_agent_thread_id
     FROM agent_threads WHERE id = ?`,
  ).get(threadId) as ThreadRow | undefined;
}

/**
 * 父关系一经建立便保持稳定；仅允许无父占位节点在 metadata 到达后首次补父。
 */
function resolveParentThreadId(
  db: DeepaaDatabase,
  path: ResolvedAgentPath,
  requestedParentThreadId: string | undefined,
  timestamp: string,
  options: UpsertAgentPathOptions | undefined,
): string | undefined {
  if (path.agentThreadId === path.rootAgentThreadId) {
    if (requestedParentThreadId === path.agentThreadId) {
      writeDiagnostic(
        db,
        "thread-hierarchy-self",
        "根 Thread 的父身份指向自身，已保持根节点父关系为空。",
        path,
        requestedParentThreadId,
        timestamp,
        options,
      );
    }
    return undefined;
  }

  const current = threadRow(db, path.agentThreadId);
  const existingParentThreadId = current?.parent_agent_thread_id ?? undefined;
  const fallbackRootIfSafe = (): ParentFallbackResolution => {
    if (existingParentThreadId) {
      return {
        parentThreadId: existingParentThreadId,
        outcome: existingParentThreadId === path.rootAgentThreadId
          ? "attached-root"
          : "kept-existing-parent",
      };
    }
    const rootProfile = actualAncestorProfile(
      db,
      path.agentSessionId,
      path.rootAgentThreadId,
    );
    const currentProfile = actualDescendantProfile(
      db,
      path.agentSessionId,
      path.agentThreadId,
      path.rootAgentThreadId,
    );
    if (
      rootProfile.cycle
      || currentProfile.cycle
      || currentProfile.containsTarget
      || rootProfile.maxDepth + currentProfile.maxDepth + 1 > 32
    ) {
      return { parentThreadId: undefined, outcome: "isolated" };
    }
    return {
      parentThreadId: path.rootAgentThreadId,
      outcome: "attached-root",
    };
  };
  const fallbackToRoot = (
    code: string,
    reason: string,
  ): string | undefined => {
    const fallback = fallbackRootIfSafe();
    const outcomeMessage: Record<FallbackOutcome, string> = {
      "attached-root": "已挂到当前 Session 真根。",
      "kept-existing-parent": "已保留既有稳定父关系。",
      isolated: "无安全 fallback，已保持隔离。",
    };
    writeDiagnostic(
      db,
      code,
      `${reason}${outcomeMessage[fallback.outcome]}`,
      path,
      requestedParentThreadId,
      timestamp,
      options,
      { fallbackOutcome: fallback.outcome },
    );
    return fallback.parentThreadId;
  };

  if (requestedParentThreadId === path.agentThreadId) {
    return fallbackToRoot(
      "thread-hierarchy-self",
      "父 Thread 与当前 Thread 相同。",
    );
  }
  if (!requestedParentThreadId) return fallbackRootIfSafe().parentThreadId;

  const parent = threadRow(db, requestedParentThreadId);
  if (parent?.agent_session_id !== path.agentSessionId) {
    return fallbackToRoot(
      "thread-hierarchy-cross-session",
      "父 Thread 属于其他 Session。",
    );
  }
  const descendantProfile = actualDescendantProfile(
    db,
    path.agentSessionId,
    path.agentThreadId,
    requestedParentThreadId,
  );
  const ancestorProfile = actualAncestorProfile(
    db,
    path.agentSessionId,
    requestedParentThreadId,
    path.rootAgentThreadId,
  );
  if (
    descendantProfile.cycle
    || ancestorProfile.cycle
    || descendantProfile.containsTarget
  ) {
    return fallbackToRoot(
      "thread-hierarchy-cycle",
      "父关系会形成 Thread 循环。",
    );
  }

  const pendingRootDepth = requestedParentThreadId !== path.rootAgentThreadId
    && !ancestorProfile.containsTarget
    ? 1
    : 0;
  if (
    ancestorProfile.maxDepth
    + descendantProfile.maxDepth
    + pendingRootDepth
    + 1
    > 32
  ) {
    return fallbackToRoot(
      "thread-hierarchy-max-depth",
      "父关系超过最大层级 32。",
    );
  }

  if (
    existingParentThreadId
    && existingParentThreadId !== requestedParentThreadId
  ) {
    writeDiagnostic(
      db,
      "thread-hierarchy-parent-conflict",
      "Thread 已有稳定父关系，已忽略后到的不同父身份。",
      path,
      requestedParentThreadId,
      timestamp,
      options,
    );
    return existingParentThreadId;
  }
  if (existingParentThreadId) return existingParentThreadId;

  return requestedParentThreadId;
}

function writeDiagnostic(
  db: DeepaaDatabase,
  code: string,
  message: string,
  path: ResolvedAgentPath,
  parentThreadId: string | undefined,
  timestamp: string,
  options: UpsertAgentPathOptions | undefined,
  additionalDetails?: Record<string, string>,
): void {
  const detailsJson = JSON.stringify({
    origin: "hierarchy-repository",
    session: path.agentSessionId,
    current: path.agentThreadId,
    parent: parentThreadId ?? null,
    root: path.rootAgentThreadId,
    ...additionalDetails,
  });
  insertDiagnostic(db, code, message, detailsJson, timestamp, options);
}

function insertDiagnostic(
  db: DeepaaDatabase,
  code: string,
  message: string,
  detailsJson: string,
  timestamp: string,
  options: UpsertAgentPathOptions | undefined,
): void {
  const exchangeId = options?.exchangeId ?? null;
  const sourceId = options?.sourceId ?? null;
  db.prepare(
    `INSERT INTO derivation_diagnostics(
      exchange_id, source_id, code, severity, message, details_json, created_at
    )
    SELECT ?, ?, ?, 'warning', ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM derivation_diagnostics
      WHERE exchange_id IS ? AND source_id IS ?
        AND code = ? AND details_json = ?
    )`,
  ).run(
    exchangeId,
    sourceId,
    code,
    message,
    detailsJson,
    timestamp,
    exchangeId,
    sourceId,
    code,
    detailsJson,
  );
}
