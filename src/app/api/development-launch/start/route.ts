import { getDevelopmentLaunchService } from "@/lib/development-launch/service";
import { normalizeDevelopmentManualOverrides } from "@/lib/development-launch/launch-plan";
import {normalizeResumeSessionId} from "@/lib/development-launch/resume-session";
import {isKnownAgentId, type AgentId, type AgentLaunchPreferences} from "@/types";
import {
  assertLocalMutationRequest,
  developmentLaunchErrorResponse,
  getLaunchNonceStore,
  readBoundedJson,
  requireLaunchNonce,
} from "@/lib/development-launch/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    requireLaunchNonce(body);
    const cliValue = body.cli;
    // 保持旧行为：缺少 cli 时仍先按 Codex 校验 Session ID，再在 cliField 拒绝。
    const resumeSessionId = typeof cliValue === "string" && isKnownAgentId(cliValue)
      ? normalizeResumeSessionId(body.resumeSessionId, cliValue)
      : normalizeResumeSessionId(body.resumeSessionId);
    const cli = cliField(body, "cli");
    const result = await getDevelopmentLaunchService().start({
      cli,
      targetId: stringField(body, "targetId"),
      projectDir: optionalStringField(body, "projectDir"),
      credentialId: optionalStringField(body, "credentialId"),
      terminal: optionalStringField(body, "terminal"),
      // 官方直连形态启动（codex 官方模式）不携带模型——模型在官方客户端内选择；
      // 网关形态由 service 强制校验（MODEL_SELECTION_REQUIRED）。
      selectedModel: body.selectedModel === undefined
        ? undefined
        : selectionField(body, "selectedModel", "MODEL_SELECTION_REQUIRED"),
      resumeSessionId,
      manualOverrides: normalizeDevelopmentManualOverrides(body.manualOverrides),
      launchPreferences: launchPreferencesField(body, "launchPreferences"),
      // 白名单含 "web"：dsh 双形态后由弹窗显式传入（此前靠 fixedLaunchMode 服务端兜底）。
      launchMode: body.launchMode === "headless" || body.launchMode === "tui" || body.launchMode === "web" || body.launchMode === "app"
        ? body.launchMode
        : undefined,
      task: optionalStringField(body, "task"),
    });
    return Response.json({ ...result, nonce: getLaunchNonceStore().issue() });
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}

function stringField(body: Record<string, unknown>, key: string): string {
  if (typeof body[key] !== "string" || !body[key]) throw new Error("INVALID_REQUEST");
  return body[key];
}

function optionalStringField(body: Record<string, unknown>, key: string): string | undefined {
  return typeof body[key] === "string" && body[key] ? body[key] : undefined;
}

function cliField(body: Record<string, unknown>, key: string): AgentId {
  const value = body[key];
  if (typeof value !== "string" || !isKnownAgentId(value)) throw new Error("INVALID_REQUEST");
  return value;
}

/** 启动偏好载荷：结构校验（深层值域由 service 按 Agent 归一化时校验）。
 * 空对象合法 —— 弹窗以完整状态提交，空对象表示清除已落库偏好。 */
function launchPreferencesField(body: Record<string, unknown>, key: string): AgentLaunchPreferences | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_REQUEST");
  const raw = value as Record<string, unknown>;
  const result: AgentLaunchPreferences = {};
  if (raw.reasoningEffort !== undefined) {
    if (typeof raw.reasoningEffort !== "string") throw new Error("INVALID_REQUEST");
    result.reasoningEffort = raw.reasoningEffort;
  }
  if (raw.permissionMode !== undefined) {
    if (typeof raw.permissionMode !== "string") throw new Error("INVALID_REQUEST");
    result.permissionMode = raw.permissionMode;
  }
  if (raw.contextWindows !== undefined) {
    if (typeof raw.contextWindows !== "object" || raw.contextWindows === null || Array.isArray(raw.contextWindows)) {
      throw new Error("INVALID_REQUEST");
    }
    result.contextWindows = raw.contextWindows as Record<string, number>;
  }
  if (raw.autoCompactTokenLimits !== undefined) {
    if (typeof raw.autoCompactTokenLimits !== "object"
      || raw.autoCompactTokenLimits === null
      || Array.isArray(raw.autoCompactTokenLimits)) {
      throw new Error("INVALID_REQUEST");
    }
    result.autoCompactTokenLimits = raw.autoCompactTokenLimits as Record<string, number>;
  }
  return result;
}

function selectionField(body: Record<string, unknown>, key: string, code: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(code);
  }
  return normalized;
}
