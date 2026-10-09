import {afterEach, describe, expect, test, vi} from "vitest";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, {recursive: true, force: true})));
  delete process.env.DEEPAA_DATA_DIR;
  vi.resetModules();
});

async function loadRoute() {
  vi.resetModules();
  return await import("../src/app/api/model-pricing/route.js");
}

describe("GET /api/model-pricing?view=fx（2026-09-28 轻量 fx 快照）", () => {
  test("返回生效配置 fx 快照（rate/asOf/source/fallback=false），几十字节不等同全量配置", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepaa-fx-view-"));
    tempRoots.push(root);
    process.env.DEEPAA_DATA_DIR = root;
    await mkdir(join(root, "config"), {recursive: true});
    await writeFile(join(root, "config", "model-pricing.json"), JSON.stringify({
      version: 2,
      models: [],
      fx: {rates: {"USD/CNY": 6.7489}, asOf: "2026-09-24", source: "CFETS（中国外汇交易中心）人民币汇率中间价"},
    }), "utf8");

    const {GET} = await loadRoute();
    const response = await GET(new Request("http://127.0.0.1:3210/api/model-pricing?view=fx"));
    expect(response.status).toBe(200);
    const body = await response.json() as {fx: {rate: number; asOf?: string; source?: string; fallback: boolean}};
    expect(body.fx.rate).toBe(6.7489);
    expect(body.fx.asOf).toBe("2026-09-24");
    expect(body.fx.source).toContain("CFETS");
    expect(body.fx.fallback).toBe(false);
    // 响应体必须保持轻量：绝不携带全量模型条目。
    expect(JSON.stringify(body).length).toBeLessThan(512);

    // 全量默认分支不受影响（仍返回完整配置对象含 fx）。
    const full = await GET(new Request("http://127.0.0.1:3210/api/model-pricing"));
    const fullBody = await full.json() as {models: unknown[]; fx?: {rates: Record<string, number>}};
    expect(Array.isArray(fullBody.models)).toBe(true);
    expect(fullBody.fx?.rates?.["USD/CNY"]).toBe(6.7489);
  });

  test("fx 快照缺失时回退随包默认（整数 7）并标记 fallback=true", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepaa-fx-view-"));
    tempRoots.push(root);
    process.env.DEEPAA_DATA_DIR = root;

    const {GET} = await loadRoute();
    const response = await GET(new Request("http://127.0.0.1:3210/api/model-pricing?view=fx"));
    expect(response.status).toBe(200);
    const body = await response.json() as {fx: {rate: number; fallback: boolean}};
    expect(body.fx.rate).toBe(7);
    expect(body.fx.fallback).toBe(true);
  });
});
