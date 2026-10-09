import {jsonResponse} from "@/lib/app-state";
import {catalogOverridePath} from "@/lib/provider-catalog/cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 维护测试模式查询（2026-09-11）：仅供官网管理台「先测后发」流程使用。
 *
 * 只返回布尔值，不回传本地绝对路径，避免把维护人员机器路径暴露到浏览器。
 * 该模式由环境变量 DEEPAA_CATALOG_PATH 决定，属进程级配置，不会持久化。
 */
export async function GET(): Promise<Response> {
  return jsonResponse({override: catalogOverridePath() !== undefined});
}
