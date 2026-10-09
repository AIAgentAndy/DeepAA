/**
 * C6 健康检查测试：注册表语义（幂等/排序/degraded）+ 路由响应形状。
 * 只读内存注册表，零 IO——刻意验证探测本身无副作用。
 */

import {describe, expect, test} from "vitest";
import {readHealthStatus, registerHealthComponent} from "../src/lib/health-status";

describe("health-status 注册表", () => {
  test("空注册表 → degraded；注册后 → ok 且按启动时刻排序", () => {
    const registry = globalThis as typeof globalThis & {
      __deepaaHealthComponents?: Map<string, unknown>;
    };
    registry.__deepaaHealthComponents = new Map();
    const empty = readHealthStatus();
    expect(empty.app).toBe("deepaa");
    expect(empty.status).toBe("degraded");
    expect(empty.components).toEqual([]);

    registerHealthComponent("ingestion-worker", 1_000);
    registerHealthComponent("provider-sync-scheduler", 2_000);
    registerHealthComponent("ingestion-worker", 3_000); // 幂等：保留最早时刻
    const report = readHealthStatus();
    expect(report.status).toBe("ok");
    expect(report.components.map(component => component.name)).toEqual([
      "ingestion-worker",
      "provider-sync-scheduler",
    ]);
    expect(report.components[0].startedAt).toBe(new Date(1_000).toISOString());
    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe("GET /api/health 路由", () => {
  test("返回 deepaa 标记 JSON 且 no-store（启动器就绪判据）", async () => {
    const registry = globalThis as typeof globalThis & {
      __deepaaHealthComponents?: Map<string, unknown>;
    };
    registry.__deepaaHealthComponents = new Map();
    registerHealthComponent("test-component");
    const {GET} = await import("../src/app/api/health/route");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.app).toBe("deepaa");
    expect(body.status).toBe("ok");
    expect(Array.isArray(body.components)).toBe(true);
  });
});
