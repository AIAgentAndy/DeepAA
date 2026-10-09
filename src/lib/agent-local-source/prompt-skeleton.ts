/**
 * 请求骨架缓存（2026-09-17 用户确认，本地导入链路的确定性补全）。
 *
 * 背景：Agent 客户端（zcode 实测）把「系统提示 + 工具定义」只写进 model-io 滚动窗口
 * （单文件 64MiB、每目录最多 3 个会话文件），窗口一转就永久消失。取不到骨架时合成的
 * 请求体只剩 model+messages，交互内容页就会缺 system/tools，并让排重把整段系统提示
 * 判成「本步骤新增」。
 *
 * 设计：**首见即存 + 会话级复用 + 缺失时借用并标注**，全程不需要用户改客户端设置：
 * - 任何一次成功读到骨架（rollout body），立刻按 (agent, session, prompt_sha256) 落库；
 * - 同 session 后续记录即使 rollout 已被清理，也能借用最近一份骨架；
 * - 借用与缺失都写 capture diagnostic，页面如实标注，绝不冒充原始 wire。
 *
 * 只读约束：本模块只写 DeepAA 自己的 SQLite，绝不写 Agent 本地目录。
 */
import { createHash } from "node:crypto";
import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";

export interface PromptSkeletonInput {
  agentId: string;
  sessionId: string;
  /** 骨架摘要 = sha256(system + tools)。 */
  promptSha256: string;
  /** 去掉 messages 的请求体 JSON 文本（system/tools/参数骨架）。 */
  bodyJson: string;
  modelId?: string;
  providerId?: string;
  toolCount: number;
}

export interface PromptSkeleton {
  skeletonId: string;
  promptSha256: string;
  bodyJson: string;
  toolCount: number;
  modelId?: string;
  providerId?: string;
  lastSeenAt: string;
}

export function promptSkeletonId(input: {
  agentId: string;
  sessionId: string;
  promptSha256: string;
}): string {
  return createHash("sha256")
    .update(`${input.agentId}\u0000${input.sessionId}\u0000${input.promptSha256}`, "utf8")
    .digest("hex");
}

/**
 * 从请求体 JSON 文本提取骨架：`system` 或 `tools` 至少有一个才算骨架；
 * 其余字段（thinking/output_config/metadata/tool_choice/max_tokens…）原样保留，
 * 只剥掉 messages（消息历史由 DB 时间线回放，绝不复用缓存）。
 */
export function extractPromptSkeleton(
  requestRawBody: string | undefined,
): {promptSha256: string; bodyJson: string; toolCount: number} | undefined {
  if (requestRawBody === undefined || requestRawBody.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestRawBody);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const hasSystem = record.system !== undefined && record.system !== null;
  const tools = Array.isArray(record.tools) ? record.tools : undefined;
  if (!hasSystem && (tools === undefined || tools.length === 0)) return undefined;
  const body: Record<string, unknown> = {...record};
  delete body.messages;
  let bodyJson: string;
  try {
    bodyJson = JSON.stringify(body);
  } catch {
    return undefined;
  }
  const promptSha256 = createHash("sha256")
    .update(JSON.stringify({system: record.system ?? null, tools: record.tools ?? null}), "utf8")
    .digest("hex");
  return {
    promptSha256,
    bodyJson,
    toolCount: tools?.length ?? 0,
  };
}

/** 幂等落库（同 (agent, session, prompt) 只保留一份，更新 last_seen_at）。 */
export function recordPromptSkeleton(
  db: DeepaaDatabase,
  input: PromptSkeletonInput,
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO agent_prompt_skeletons(
      skeleton_id, agent_id, session_id, prompt_sha256, model_id, provider_id,
      body_json, tool_count, first_seen_at, last_seen_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(skeleton_id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      model_id = COALESCE(excluded.model_id, agent_prompt_skeletons.model_id),
      provider_id = COALESCE(excluded.provider_id, agent_prompt_skeletons.provider_id)
  `).run(
    promptSkeletonId(input),
    input.agentId,
    input.sessionId,
    input.promptSha256,
    input.modelId ?? null,
    input.providerId ?? null,
    input.bodyJson,
    input.toolCount,
    now,
    now,
  );
}

/** 取该会话最近一次见到的骨架（无则 undefined）。 */
export function loadLatestPromptSkeleton(
  db: DeepaaDatabase,
  agentId: string,
  sessionId: string,
): PromptSkeleton | undefined {
  const row = db.prepare(`
    SELECT skeleton_id, prompt_sha256, body_json, tool_count, model_id, provider_id, last_seen_at
    FROM agent_prompt_skeletons
    WHERE agent_id = ? AND session_id = ?
    ORDER BY last_seen_at DESC
    LIMIT 1
  `).get(agentId, sessionId) as {
    skeleton_id: string;
    prompt_sha256: string;
    body_json: string;
    tool_count: number;
    model_id: string | null;
    provider_id: string | null;
    last_seen_at: string;
  } | undefined;
  if (!row) return undefined;
  return {
    skeletonId: row.skeleton_id,
    promptSha256: row.prompt_sha256,
    bodyJson: row.body_json,
    toolCount: row.tool_count,
    ...(row.model_id !== null ? {modelId: row.model_id} : {}),
    ...(row.provider_id !== null ? {providerId: row.provider_id} : {}),
    lastSeenAt: row.last_seen_at,
  };
}
