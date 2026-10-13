import {afterEach, describe, expect, test} from "vitest";
import {mkdtemp, rm, writeFile} from "fs/promises";
import {tmpdir} from "os";
import {join} from "path";
import {GatewayTokenResolver} from "../src/proxy/token-resolver.js";

/** 假凭据 helper：按 credentialId 回显可控 token，覆盖干净/脏/空三种输出。 */
const FAKE_HELPER = `
const action = process.argv[2];
const id = process.argv[3];
if (action === "get") {
  if (id === "cred-dirty") process.stdout.write("sk-\\u706b\\u5c71-token\\n");
  else if (id === "cred-empty") process.stdout.write("");
  else process.stdout.write("sk-clean-token");
}
`;

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, {recursive: true, force: true})));
});

describe("GatewayTokenResolver：解析出的 token 必须能安全拼进 Authorization 头（2026-10-13 事故）", () => {
  test("干净 token 正常解析", async () => {
    const helperPath = await writeFakeHelper();
    const resolver = new GatewayTokenResolver({credentialHelperPath: helperPath});
    expect(await resolver.resolve("cred-any")).toBe("sk-clean-token");
  });

  test("含非 Latin-1 字符（中文）的存量脏 token 在解析层被拒绝", async () => {
    const helperPath = await writeFakeHelper();
    const resolver = new GatewayTokenResolver({credentialHelperPath: helperPath});
    // 事故实录形态：密钥粘入中文名后存库。保存校验上线前入系统凭据库的
    // 存量脏数据由这里兜底——否则 http.request 同步抛 Invalid character。
    await expect(resolver.resolve("cred-dirty")).rejects.toThrow("CREDENTIAL_TOKEN_INVALID_CHARS");
    // 脏 token 不得入缓存：同 ID 重试仍应被拒绝而不是吐出脏值。
    await expect(resolver.resolve("cred-dirty")).rejects.toThrow("CREDENTIAL_TOKEN_INVALID_CHARS");
  });

  test("空输出仍按读取失败处理（既有语义不变）", async () => {
    const helperPath = await writeFakeHelper();
    const resolver = new GatewayTokenResolver({credentialHelperPath: helperPath});
    await expect(resolver.resolve("cred-empty")).rejects.toThrow("CREDENTIAL_READ_FAILED");
  });

  async function writeFakeHelper(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "deepaa-token-resolver-"));
    tempRoots.push(root);
    const helperPath = join(root, "fake-credential-helper.mjs");
    await writeFile(helperPath, FAKE_HELPER, "utf8");
    return helperPath;
  }
});
