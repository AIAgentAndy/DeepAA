import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, test} from "vitest";
import {ReplayBodyStore} from "../src/proxy/replay-body.js";

async function tempStore(options: Partial<ConstructorParameters<typeof ReplayBodyStore>[0]> = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), "replay-body-"));
  return ReplayBodyStore.create({tempDir, ...options});
}

async function readAll(reader: ReturnType<ReplayBodyStore["createReader"]>): Promise<Buffer> {
  if (!reader) throw new Error("reader missing");
  const chunks: Buffer[] = [];
  for await (const chunk of reader) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe("ReplayBodyStore", () => {
  test("小请求全程内存缓冲，重放字节与原请求逐字节一致", async () => {
    const store = await tempStore();
    const body = Buffer.from(JSON.stringify({model: "gpt-test_a.example", input: "你好".repeat(100)}));
    store.write(body);
    store.end();
    expect(store.canReplay).toBe(true);
    const first = await readAll(store.createReader());
    const second = await readAll(store.createReader());
    expect(first).toEqual(body);
    expect(second).toEqual(body);
    await store.release();
    expect(store.canReplay).toBe(false);
  });

  test("超出内存上限后溢写磁盘，重放仍完整", async () => {
    const store = await tempStore({memoryLimitBytes: 1024, pendingLimitBytes: 1024 * 1024});
    const body = Buffer.from("B".repeat(16 * 1024));
    for (let offset = 0; offset < body.length; offset += 512) {
      store.write(body.subarray(offset, offset + 512));
    }
    store.end();
    const replayed = await readAll(store.createReader());
    expect(replayed.length).toBe(body.length);
    expect(replayed).toEqual(body);
    await store.release();
  });

  test("读者先于写入结束时仍能跟随实时流（边写边读）", async () => {
    const store = await tempStore();
    const reader = store.createReader();
    expect(reader).toBeDefined();
    const half = Buffer.from("hello ".repeat(100));
    store.write(half);
    const pending = readAll(reader);
    const otherHalf = Buffer.from("world".repeat(100));
    store.write(otherHalf);
    store.end();
    const replayed = await pending;
    expect(replayed).toEqual(Buffer.concat([half, otherHalf]));
    await store.release();
  });

  test("超出单请求硬上限即标记溢出：不再允许新读者（放弃重试）", async () => {
    const store = await tempStore({memoryLimitBytes: 512, maxBytes: 4096});
    store.write(Buffer.from("A".repeat(4097)));
    expect(store.canReplay).toBe(false);
    expect(store.createReader()).toBeUndefined();
    await store.release();
  });

  test("release 后不可再创建读者", async () => {
    const store = await tempStore();
    store.write(Buffer.from("data"));
    store.end();
    await store.release();
    expect(store.createReader()).toBeUndefined();
  });
});
