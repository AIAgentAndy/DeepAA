import {
  assertLocalMutationRequest,
  developmentLaunchErrorResponse,
  getLaunchNonceStore,
  readBoundedJson,
  requireLaunchNonce,
} from "@/lib/development-launch/security";
import {getSyncService} from "@/lib/sync-engine/service";
import {
  isSyncIntervalMinutes,
  type SyncIntervalMinutes,
  type SyncProviderType,
} from "@/lib/sync-engine/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    requireLaunchNonce(body);
    // 先做纯请求校验，再初始化服务：非法周期不触碰同步引擎。
    const syncIntervalMinutes = optionalSyncIntervalField(body);
    const {account, sync} = await (await getSyncService()).saveConsoleAccount({
      targetId: stringField(body, "targetId"),
      providerType: providerField(body),
      consoleBaseUrl: stringField(body, "consoleBaseUrl"),
      // 修改模式允许用户名/密码留空：服务端保留已有凭据原值。
      username: optionalStringField(body, "username"),
      password: optionalStringField(body, "password"),
      syncIntervalMinutes,
    });
    // sync 是保存后立即执行的首次同步结果；失败时页面据此立刻提醒用户。
    return Response.json({account, sync, nonce: getLaunchNonceStore().issue()}, {status: 201});
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    requireLaunchNonce(body);
    const targetId = stringField(body, "targetId");
    const removed = await (await getSyncService()).removeConsoleAccount(targetId);
    return Response.json({removed, nonce: getLaunchNonceStore().issue()});
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}

function stringField(body: Record<string, unknown>, key: string): string {
  if (typeof body[key] !== "string" || !body[key].trim()) throw new Error("INVALID_REQUEST");
  return body[key].trim();
}

/** 可选字符串：允许空字符串（表示保留原值），但缺失或非字符串仍视为非法请求。 */
function optionalStringField(body: Record<string, unknown>, key: string): string {
  if (typeof body[key] !== "string") throw new Error("INVALID_REQUEST");
  return body[key].trim();
}

/** 可选同步周期（分钟）：传入时必须是白名单值域，否则视为非法请求。 */
function optionalSyncIntervalField(body: Record<string, unknown>): SyncIntervalMinutes | undefined {
  const value = body.syncIntervalMinutes;
  if (value === undefined || value === null) return undefined;
  if (isSyncIntervalMinutes(value)) return value;
  throw new Error("INVALID_REQUEST");
}

const SYNC_PROVIDER_TYPES: readonly SyncProviderType[] = [
  "newapi",
  "sub2api",
  "relay",
  "deepseek",
  "manual",
  "openai",
  "anthropic",
  "openrouter",
  "siliconflow",
  "qwenai",
  "tencent-hunyuan",
  "kimi-coding",
  "zhipu",
  "minimax",
  "volcengine-plan",
  "opencode-go",
];

/** 站点类型只允许注册表内取值；是否可保存由服务端按能力再次校验。 */
function providerField(body: Record<string, unknown>): SyncProviderType {
  const value = body.providerType;
  if (typeof value === "string" && (SYNC_PROVIDER_TYPES as readonly string[]).includes(value)) {
    return value as SyncProviderType;
  }
  throw new Error("INVALID_REQUEST");
}
