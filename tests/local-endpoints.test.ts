import {describe, expect, test} from "vitest";
import {
  DEFAULT_GATEWAY_BASE_URL,
  DSH_WEB_URL,
  isLoopbackAliasHostname,
  isLoopbackHostname,
  isSameLocalEntrypoint,
  normalizeLoopbackAliasBaseUrl,
  resolveGatewayBaseUrl,
} from "../src/lib/local-endpoints.js";
import {createCliSyncContext} from "../src/lib/config-sync/core/sync-context.js";
import type {CatalogOverrides, CatalogTemplate} from "../src/lib/config-sync/catalog-template.js";
import type {ProxyConfig} from "../src/types.js";

/**
 * 全站统一 127.0.0.1（2026-09-19 用户确认）守卫测试：
 * 任何写入 CLI 受管配置的网关地址都不得携带 localhost/::1 别名，
 * 否则 SameSite=Strict 的 dsh 会话 cookie 会在跨站弹窗导航中被扣发（dsh 401）。
 */

function emptyConfig(): ProxyConfig {
  return {
    version: 3,
    revision: 1,
    agentConnections: {},
    targets: [],
    localProxyBaseUrl: DEFAULT_GATEWAY_BASE_URL,
    updatedAt: "2026-09-19T00:00:00.000Z",
  };
}

const template = {agents: {}} as unknown as CatalogTemplate;
const overrides = {} as unknown as CatalogOverrides;

describe("normalizeLoopbackAliasBaseUrl", () => {
  test("localhost 别名归一化为 127.0.0.1 且保留端口", () => {
    expect(normalizeLoopbackAliasBaseUrl("http://localhost:3211")).toBe("http://127.0.0.1:3211");
    expect(normalizeLoopbackAliasBaseUrl("http://localhost")).toBe("http://127.0.0.1");
    expect(normalizeLoopbackAliasBaseUrl("https://localhost:3210/x")).toBe("https://127.0.0.1:3210/x");
  });

  test("::1 与 [::1] 别名归一化为 127.0.0.1", () => {
    expect(normalizeLoopbackAliasBaseUrl("http://[::1]:3211")).toBe("http://127.0.0.1:3211");
    expect(normalizeLoopbackAliasBaseUrl("http://[::1]")).toBe("http://127.0.0.1");
  });

  test("127.0.0.1 与自定义主机原样保留", () => {
    expect(normalizeLoopbackAliasBaseUrl("http://127.0.0.1:3211")).toBe("http://127.0.0.1:3211");
    expect(normalizeLoopbackAliasBaseUrl("http://192.168.1.9:3211")).toBe("http://192.168.1.9:3211");
    expect(normalizeLoopbackAliasBaseUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1");
  });

  test("非法与空输入按 trim 原样返回、不抛错", () => {
    expect(normalizeLoopbackAliasBaseUrl("")).toBe("");
    expect(normalizeLoopbackAliasBaseUrl("   ")).toBe("");
    expect(normalizeLoopbackAliasBaseUrl("not-a-url")).toBe("not-a-url");
  });
});

describe("resolveGatewayBaseUrl", () => {
  test("空值回退规范缺省 127.0.0.1:3211", () => {
    expect(resolveGatewayBaseUrl(undefined)).toBe(DEFAULT_GATEWAY_BASE_URL);
    expect(resolveGatewayBaseUrl(null)).toBe(DEFAULT_GATEWAY_BASE_URL);
    expect(resolveGatewayBaseUrl("")).toBe(DEFAULT_GATEWAY_BASE_URL);
    expect(DEFAULT_GATEWAY_BASE_URL).toBe("http://127.0.0.1:3211");
  });

  test("存量 localhost 配置值读取时归一化", () => {
    expect(resolveGatewayBaseUrl("http://localhost:3211")).toBe("http://127.0.0.1:3211");
    expect(resolveGatewayBaseUrl("http://localhost:9999")).toBe("http://127.0.0.1:9999");
  });

  test("去除尾随斜杠；非 loopback 自定义值不改写", () => {
    expect(resolveGatewayBaseUrl("http://localhost:3211/")).toBe("http://127.0.0.1:3211");
    expect(resolveGatewayBaseUrl("http://192.168.1.9:3211/")).toBe("http://192.168.1.9:3211");
  });
});

describe("CLI 配置写盘守卫：sync-context 归一化", () => {
  test("paths.gatewayBaseUrl 为 localhost 时上下文输出 127.0.0.1", () => {
    const context = createCliSyncContext({
      config: emptyConfig(),
      paths: {
        gatewayBaseUrl: "http://localhost:3211",
        gatewayBearerToken: "deepaa-gateway",
      },
      template,
      overrides,
    });
    expect(context.gatewayBaseUrl).toBe("http://127.0.0.1:3211");
  });

  test("缺省与别名输入统一收敛到 127.0.0.1", () => {
    const context = createCliSyncContext({
      config: emptyConfig(),
      paths: {gatewayBaseUrl: ""},
      template,
      overrides,
    });
    expect(context.gatewayBaseUrl).toBe("http://127.0.0.1:3211");
  });
});

describe("本地端点常量", () => {
  test("dsh Web 地址为 127.0.0.1", () => {
    expect(DSH_WEB_URL).toBe("http://127.0.0.1:3080");
  });

  test("isLoopbackAliasHostname 判定", () => {
    expect(isLoopbackAliasHostname("localhost")).toBe(true);
    expect(isLoopbackAliasHostname("LOCALHOST")).toBe(true);
    expect(isLoopbackAliasHostname("[::1]")).toBe(true);
    expect(isLoopbackAliasHostname("::1")).toBe(true);
    expect(isLoopbackAliasHostname("127.0.0.1")).toBe(false);
    expect(isLoopbackAliasHostname("example.com")).toBe(false);
  });
});

describe("安全闸门共享判定：isLoopbackHostname / isSameLocalEntrypoint", () => {
  test("isLoopbackHostname 同时接受 localhost、::1 与 127/8 字面量", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("LOCALHOST")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("127.0.0.9")).toBe(true);
    expect(isLoopbackHostname("example.com")).toBe(false);
    expect(isLoopbackHostname("128.0.0.1")).toBe(false);
  });

  test("isSameLocalEntrypoint：逐字相等优先，回环别名同端口视为同一本机入口", () => {
    expect(isSameLocalEntrypoint(new URL("http://localhost:3210"), new URL("http://localhost:3210"))).toBe(true);
    expect(isSameLocalEntrypoint(new URL("http://localhost:3210"), new URL("http://127.0.0.1:3210"))).toBe(true);
    expect(isSameLocalEntrypoint(new URL("http://localhost:3210"), new URL("http://[::1]:3210"))).toBe(true);
    expect(isSameLocalEntrypoint(new URL("http://127.0.0.1:3210"), new URL("http://127.0.0.9:3210"))).toBe(true);
  });

  test("isSameLocalEntrypoint：端口不同或非回环主机不等价", () => {
    expect(isSameLocalEntrypoint(new URL("http://localhost:3210"), new URL("http://127.0.0.1:9999"))).toBe(false);
    expect(isSameLocalEntrypoint(new URL("http://evil.com:3210"), new URL("http://localhost:3210"))).toBe(false);
    expect(isSameLocalEntrypoint(new URL("http://evil.com:3210"), new URL("http://evil.com:9999"))).toBe(false);
  });
});
