import {expect, test} from "vitest";
import {GET, POST} from "../src/app/api/config-sync/route.js";
import {GET as GET_FILE} from "../src/app/api/config-sync/file/route.js";
import {DELETE as deleteConsoleAccount} from "../src/app/api/proxy-sync/console-account/route.js";

function mutationRequest(url: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: {
      origin: "http://localhost:3210",
      host: "localhost:3210",
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("config-sync GET 颁发单次 nonce，POST 缺 nonce 时在同步前拒绝", async () => {
  const preview = await GET();
  const payload = await preview.json() as {nonce?: string; fileDisplays?: Record<string, Array<Record<string, unknown>>>};
  expect(payload.nonce).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
  const specIdsByAgent = Object.fromEntries(Object.entries(payload.fileDisplays || {}).map(([agent, files]) => [
    agent,
    files.map(file => file.specId),
  ]));
  expect(specIdsByAgent).toEqual({
    codex: ["codex-config", "codex-catalog"],
    claude: ["claude-user"],
    opencode: ["opencode-global"],
    dsh: ["dsh-settings", "dsh-credentials"],
    zcode: ["zcode-config", "zcode-provider-config", "zcode-state"],
  });
  for (const files of Object.values(payload.fileDisplays || {})) {
    for (const file of files) {
      expect(file).not.toHaveProperty("content");
      expect(file).not.toHaveProperty("sections");
      expect(file.fileId).toEqual(expect.any(String));
      expect(file.description).toEqual(expect.any(String));
      expect(file.managedNamespaces).toEqual(expect.any(Array));
      expect(["partial", "full", "sensitive"]).toContain(file.ownership);
      expect(["ready", "missing", "pending-create", "sensitive", "error"]).toContain(file.status);
    }
  }

  const response = await POST(mutationRequest("http://localhost:3210/api/config-sync", {action: "sync"}));
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({error: "LAUNCH_NONCE_INVALID"});
});

test("config-sync POST 强制 Sec-Fetch-Site same-origin", async () => {
  const preview = await GET();
  const {nonce} = await preview.json() as {nonce: string};
  const response = await POST(mutationRequest(
    "http://localhost:3210/api/config-sync",
    {action: "sync", nonce},
    {"sec-fetch-site": "none"},
  ));

  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({error: "LOCAL_ORIGIN_REQUIRED"});
});

test("配置文件预览 GET 未带 Origin 时不会被误判为远程请求", async () => {
  const response = await GET_FILE(new Request("http://localhost:3210/api/config-sync/file", {
    headers: {host: "localhost:3210", "sec-fetch-site": "same-origin"},
  }));
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({error: "CONFIG_FILE_PREVIEW_INVALID"});
});

test("控制台账号 DELETE 必须从 JSON body 消费 nonce，不接受查询参数替代", async () => {
  const response = await deleteConsoleAccount(new Request(
    "http://localhost:3210/api/proxy-sync/console-account?targetId=ai98pro",
    {
      method: "DELETE",
      headers: {
        origin: "http://localhost:3210",
        host: "localhost:3210",
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({targetId: "ai98pro"}),
    },
  ));

  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({error: "LAUNCH_NONCE_INVALID"});
});
