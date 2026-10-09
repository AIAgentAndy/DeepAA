import {describe, expect, test} from "vitest";
import {assertRawStreamRequest} from "../src/lib/raw-stream-gateway.js";
import {
  assertLocalMutationRequest,
  assertLocalReadRequest,
} from "../src/lib/development-launch/security.js";

/**
 * 回环别名等价守卫（2026-09-19）。
 * Next 16 生产服务会把路由处理器的 request.url 主机名规范化为 localhost；
 * 页面以 127.0.0.1:端口 访问时 Host 头/Origin 与 request.url 字面不同但同机。
 * 两个安全闸门——raw 完整内容闸门（assertRawStreamRequest）与开发启动/配置同步
 * 闸门（development-launch/security.ts 的 assertLocalReadRequest 等）——都必须视为
 * 等价放行；非回环主机与端口不符仍然拒绝。
 */

// 模拟 Next 16 生产运行时：request.url 的主机名已被规范化为 localhost。
const URL_SEEN_BY_SERVER = "http://localhost:3210/api/exchanges/x/raw";

function probe(headers: Record<string, string>): () => void {
  return () => assertRawStreamRequest(new Request(URL_SEEN_BY_SERVER, {headers}));
}

describe("assertRawStreamRequest 回环别名等价", () => {
  test("Host: localhost（与规范化地址一致）放行", () => {
    expect(probe({"host": "localhost:3210"})).not.toThrow();
  });

  test("修复点：Host: 127.0.0.1 同端口视为同一本机入口放行", () => {
    expect(probe({"host": "127.0.0.1:3210"})).not.toThrow();
  });

  test("Host: [::1] 同端口放行", () => {
    expect(probe({"host": "[::1]:3210"})).not.toThrow();
  });

  test("Origin: 127.0.0.1 同端口放行", () => {
    expect(probe({origin: "http://127.0.0.1:3210"})).not.toThrow();
  });

  test("无 Host / 无 Origin / 无 sec-fetch-site 的本机客户端放行", () => {
    expect(probe({})).not.toThrow();
  });

  test("非回环 Host（DNS rebinding / 跨站伪造）拒绝", () => {
    expect(probe({"host": "evil.com:3210"})).toThrow();
  });

  test("非回环 Origin 拒绝", () => {
    expect(probe({origin: "http://evil.com:3210"})).toThrow();
  });

  test("回环但端口不一致拒绝", () => {
    expect(probe({"host": "127.0.0.1:9999"})).toThrow();
    expect(probe({origin: "http://127.0.0.1:9999"})).toThrow();
  });

  test("sec-fetch-site: cross-site 拒绝，same-origin / none / 缺省放行", () => {
    expect(probe({"sec-fetch-site": "cross-site"})).toThrow();
    expect(probe({"sec-fetch-site": "same-origin"})).not.toThrow();
    expect(probe({"sec-fetch-site": "none"})).not.toThrow();
  });
});

// development-launch/security.ts 的只读/变更闸门走同一份「同机等价」判定
// （local-endpoints.isSameLocalEntrypoint），此处按相同场景守卫，防止回退逐字比较。
const READ_URL_SEEN_BY_SERVER = "http://localhost:3210/api/config-sync/file?fileId=codex:codex-config:0";

function readProbe(headers: Record<string, string>): () => void {
  return () => assertLocalReadRequest(new Request(READ_URL_SEEN_BY_SERVER, {headers}));
}

describe("assertLocalReadRequest 回环别名等价（development-launch/security.ts）", () => {
  test("修复点：无 Origin 的同源 GET，Host: 127.0.0.1 同端口放行", () => {
    expect(readProbe({"host": "127.0.0.1:3210", "sec-fetch-site": "same-origin"})).not.toThrow();
  });

  test("Host: localhost（与规范化地址一致）放行", () => {
    expect(readProbe({"host": "localhost:3210", "sec-fetch-site": "same-origin"})).not.toThrow();
  });

  test("Host: [::1] 同端口放行", () => {
    expect(readProbe({"host": "[::1]:3210", "sec-fetch-site": "same-origin"})).not.toThrow();
  });

  test("带 Origin：Origin 与 Host 同为 127.0.0.1 放行", () => {
    expect(readProbe({
      "host": "127.0.0.1:3210",
      "origin": "http://127.0.0.1:3210",
      "sec-fetch-site": "same-origin",
    })).not.toThrow();
  });

  test("非回环 Host（DNS rebinding / 跨站伪造）拒绝", () => {
    expect(readProbe({"host": "evil.com:3210", "sec-fetch-site": "same-origin"})).toThrow();
  });

  test("回环但端口不符拒绝", () => {
    expect(readProbe({"host": "127.0.0.1:9999", "sec-fetch-site": "same-origin"})).toThrow();
  });

  test("缺失 Host / 缺失 sec-fetch-site 拒绝", () => {
    expect(readProbe({"sec-fetch-site": "same-origin"})).toThrow();
    expect(readProbe({"host": "127.0.0.1:3210"})).toThrow();
  });

  test("无 Origin 的跨站 GET 拒绝", () => {
    expect(readProbe({"host": "127.0.0.1:3210", "sec-fetch-site": "cross-site"})).toThrow();
  });

  test("变更闸门保持既有口径：JSON + Origin/Host 一致放行，Origin 主机与 Host 头不一致拒绝", () => {
    const allowed = new Request("http://localhost:3210/api/development-launch/start", {
      method: "POST",
      headers: {
        "host": "127.0.0.1:3210",
        "origin": "http://127.0.0.1:3210",
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: "{}",
    });
    expect(() => assertLocalMutationRequest(allowed)).not.toThrow();

    // Origin 分支比较的是 Origin 头与 Host 头（均为客户端侧、浏览器同源请求天然一致），
    // 保持逐字相等即可，不随 request.url 规范化放宽。
    const crossAlias = new Request("http://localhost:3210/api/development-launch/start", {
      method: "POST",
      headers: {
        "host": "127.0.0.1:3210",
        "origin": "http://localhost:3210",
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: "{}",
    });
    expect(() => assertLocalMutationRequest(crossAlias)).toThrow();
  });
});
