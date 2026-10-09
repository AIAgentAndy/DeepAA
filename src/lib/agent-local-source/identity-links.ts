/**
 * 本地原生身份标注（2026-09-17 dsh 双链路）：dsh 的 wire 请求不携带任何会话身份
 * （deepseek-harness attribution 设计决定），但其本地 session v3 事件日志有完整的
 * 原生 session/turn/step 与 responseId，且 responseId 与网关捕获响应的
 * providerItemId 完全一致（确定性 join 键）。
 *
 * 本模块只承载「身份回填」：经网关的 dsh 流量以网关 raw 为唯一权威来源（wire 保真、
 * 计价、账本零改动），标注表仅提供 session/thread/turn 结构字段——不 含 用 量、
 * 不 含 模 型、不 含 金 额，结构上不可能污染计价链。
 */

import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import type {AgentLocalIdentityLink} from "./types";

/**
 * 声明身份标注的 Agent 集合（Worker 侧按此启用原生身份回填）。
 * 刻意不从 registry 静态导入：registry 会在模块加载期实例化各 adapter（zcode
 * 适配器在构造时捕获 ZCODE_CLI_DIR 环境变量），静态链会让测试文件顶部的静态
 * import 抢在环境变量赋值之前实例化 adapter（实测 314 条真实数据泄漏入夹具）。
 * 与 registry 的一致性由 tests/sqlite-dsh-local-import.test.ts 守卫。
 */
export const AGENT_LOCAL_IDENTITY_AGENT_IDS: ReadonlySet<string> = new Set<string>(["dsh"]);

export function isAgentLocalIdentityAgent(agentName: string): boolean {
  return AGENT_LOCAL_IDENTITY_AGENT_IDS.has(agentName);
}


/**
 * 派生侧等待标注的年龄窗口：超窗按现状派生并写 dsh_identity_missing 诊断
 * （顺延的有界性保证——身份等待只对「新近 exchange」生效）。
 */
export const DSH_IDENTITY_PENDING_MAX_AGE_MS = 90_000;
/**
 * 身份等待顺延时长（2026-09-22）：对齐本地扫描 2s 节拍，worker 把任务交还队列后
 * 由空闲轮询到点重新领取。顺延不写错误码、不消耗 attempt_count（错误重试预算
 * 只留给真实失败），「等待」不再复用通用错误管道。
 */
export const DSH_IDENTITY_DEFER_DELAY_MS = 2_000;
/**
 * 扫描就绪等待的顺延粒度（2026-09-22）：重启追赶期的旧行等待扫描收敛（典型
 * 25~60s、熔断上限 5 分钟）用低频粒度，减少每轮「领取 + 行读取 + 投影」空转。
 */
export const DSH_SCAN_WAIT_DEFER_DELAY_MS = 5_000;

export function upsertAgentLocalIdentityLinks(
  db: DeepaaDatabase,
  links: readonly AgentLocalIdentityLink[],
): void {
  if (links.length === 0) return;
  const upsert = db.prepare(
    `INSERT INTO agent_local_identity_links(
      response_id, agent_name, external_session_id, parent_external_session_id,
      root_external_session_id,
      turn_number, step_number, delegation_depth, model_id, recorded_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(response_id) DO NOTHING`,
  );
  const write = db.transaction((rows: readonly AgentLocalIdentityLink[]) => {
    for (const link of rows) {
      upsert.run(
        link.responseId,
        link.agentId,
        link.externalSessionId,
        link.parentExternalSessionId ?? null,
        link.rootExternalSessionId ?? null,
        link.turnNumber ?? null,
        link.stepNumber ?? null,
        link.delegationDepth ?? null,
        null,
        link.recordedAt,
      );
    }
  });
  write(links);
}

export interface AgentLocalIdentityMatch {
  externalSessionId: string;
  parentExternalSessionId?: string;
  rootExternalSessionId?: string;
  turnNumber?: number;
  stepNumber?: number;
  delegationDepth?: number;
}

export function lookupAgentLocalIdentityLink(
  db: DeepaaDatabase,
  agentName: string,
  responseId: string,
): AgentLocalIdentityMatch | undefined {
  if (!responseId) return undefined;
  const row = db.prepare(
    `SELECT external_session_id, parent_external_session_id, root_external_session_id,
       turn_number, step_number, delegation_depth
     FROM agent_local_identity_links
     WHERE agent_name = ? AND response_id = ?`,
  ).get(agentName, responseId) as {
    external_session_id: string;
    parent_external_session_id: string | null;
    root_external_session_id: string | null;
    turn_number: number | null;
    step_number: number | null;
    delegation_depth: number | null;
  } | undefined;
  if (!row) return undefined;
  return {
    externalSessionId: row.external_session_id,
    ...(row.parent_external_session_id ? {parentExternalSessionId: row.parent_external_session_id} : {}),
    ...(row.root_external_session_id ? {rootExternalSessionId: row.root_external_session_id} : {}),
    ...(row.turn_number !== null ? {turnNumber: row.turn_number} : {}),
    ...(row.step_number !== null ? {stepNumber: row.step_number} : {}),
    ...(row.delegation_depth !== null ? {delegationDepth: row.delegation_depth} : {}),
  };
}
