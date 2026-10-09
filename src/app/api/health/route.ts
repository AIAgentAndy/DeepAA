import {readHealthStatus} from "@/lib/health-status";

/**
 * C6 健康检查（2026-10-05 批次 2 用户确认）：三级语义中的前两级——
 * 路由可响应 = 「进程活着 / Web 可达」；components 非空 = 「后台组件已启动」。
 * 刻意不做派生深度诊断（查库），保证探测零副作用（不触发导出/正文读取/同步），
 * 可被启动器 readiness 轮询高频调用。
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json(readHealthStatus(), {
    headers: {"Cache-Control": "no-store"},
  });
}
