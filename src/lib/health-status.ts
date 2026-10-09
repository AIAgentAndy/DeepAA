/**
 * 健康状态注册表（C6，2026-10-05 批次 2 用户确认）：
 * `GET /api/health` 的三级语义——「进程活着」（路由可响应）由路由本身证明；
 * 「后台组件已启动」由 instrumentation 在各调度器成功启动时注册到本表；
 * 「派生健康」属于深度诊断（需查库），刻意不在健康检查里做——探测绝不触发
 * 导出、正文读取或供应商同步（发布门槛方案的约束）。
 *
 * 注册表刻意只存内存（globalThis）：健康检查回答的是「本进程此刻是否完整」，
 * 不是持久审计记录。
 */

interface HealthComponent {
  name: string;
  startedAt: number;
}

type HealthGlobal = typeof globalThis & {
  __deepaaHealthComponents?: Map<string, HealthComponent>;
};

function componentRegistry(): Map<string, HealthComponent> {
  const globalState = globalThis as HealthGlobal;
  if (!globalState.__deepaaHealthComponents) {
    globalState.__deepaaHealthComponents = new Map();
  }
  return globalState.__deepaaHealthComponents;
}

/** 幂等注册一个后台组件（同名重复注册保留最早启动时刻）。 */
export function registerHealthComponent(name: string, now = Date.now()): void {
  const registry = componentRegistry();
  if (!registry.has(name)) registry.set(name, {name, startedAt: now});
}

export interface DeepaaHealthReport {
  app: "deepaa";
  status: "ok" | "degraded";
  /** 本进程已运行秒数（process.uptime，进程视角而非请求视角）。 */
  uptimeSeconds: number;
  components: Array<{name: string; startedAt: string}>;
}

/** 读取健康快照：只读内存注册表，零 IO、零库访问。 */
export function readHealthStatus(): DeepaaHealthReport {
  const components = [...componentRegistry().values()]
    .sort((left, right) => left.startedAt - right.startedAt)
    .map(component => ({name: component.name, startedAt: new Date(component.startedAt).toISOString()}));
  return {
    app: "deepaa",
    status: components.length > 0 ? "ok" : "degraded",
    uptimeSeconds: Math.floor(process.uptime()),
    components,
  };
}
