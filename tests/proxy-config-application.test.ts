import {mkdtemp, writeFile} from "node:fs/promises";
import {createServer} from "node:net";
import {once} from "node:events";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {describe, expect, test} from "vitest";
import {
  readRoutingAppliedStatus,
  isRoutingRevisionApplied,
  waitForRoutingRevision,
} from "../src/lib/proxy-routing-status.js";

describe("代理配置应用确认", () => {
  test("waits for the saved revision and returns the applying proxy instance", async () => {
    const root = await mkdtemp(join(tmpdir(), "proxy-applied-"));
    const statusPath = join(root, "proxy-routing-status.json");
    await writeFile(statusPath, JSON.stringify({
      appliedRevision: 4,
      proxyInstanceId: "old-proxy",
      appliedAt: "2026-07-21T00:00:00.000Z",
    }));
    const pending = waitForRoutingRevision(statusPath, 5, {timeoutMs: 500, pollIntervalMs: 10});
    await delay(25);
    await writeFile(statusPath, JSON.stringify({
      appliedRevision: 5,
      proxyInstanceId: "current-proxy",
      appliedAt: "2026-07-21T00:00:01.000Z",
    }));

    await expect(pending).resolves.toMatchObject({
      appliedRevision: 5,
      proxyInstanceId: "current-proxy",
    });
  });

  test("times out as not applied without unbounded waiting", async () => {
    const root = await mkdtemp(join(tmpdir(), "proxy-not-applied-"));
    const statusPath = join(root, "proxy-routing-status.json");
    const startedAt = Date.now();

    await expect(waitForRoutingRevision(statusPath, 9, {
      timeoutMs: 40,
      pollIntervalMs: 5,
    })).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  test("rejects malformed or oversized status markers", async () => {
    const root = await mkdtemp(join(tmpdir(), "proxy-status-invalid-"));
    const statusPath = join(root, "proxy-routing-status.json");
    await writeFile(statusPath, "{ invalid");
    await expect(readRoutingAppliedStatus(statusPath)).resolves.toBeUndefined();
    await writeFile(statusPath, "x".repeat(17 * 1024));
    await expect(readRoutingAppliedStatus(statusPath)).resolves.toBeUndefined();
  });

  test("treats a stale applied marker as unavailable after the proxy port closes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "proxy-applied-liveness-"));
    await writeFile(join(dataDir, "proxy-routing-status.json"), JSON.stringify({
      appliedRevision: 7,
      proxyInstanceId: "stale-proxy",
      appliedAt: "2026-07-21T00:00:00.000Z",
    }));
    const server = createServer(socket => socket.end());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture 未监听 TCP 端口");
    const localProxyBaseUrl = `http://127.0.0.1:${address.port}`;

    await expect(isRoutingRevisionApplied(dataDir, 7, localProxyBaseUrl)).resolves.toBe(true);
    server.close();
    await once(server, "close");
    await expect(isRoutingRevisionApplied(dataDir, 7, localProxyBaseUrl)).resolves.toBe(false);
  });
});
