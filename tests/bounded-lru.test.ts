/**
 * 字节预算有界 LRU 公共件守卫（2026-10-10 A 修复）：
 * 插入序即使用序、命中重插、超预算逐出最旧、至少保留 1 条、覆盖更新字节数。
 */
import assert from "node:assert/strict";
import {describe, test} from "vitest";
import {BoundedLruMap} from "@/lib/agent-local-source/bounded-lru";

describe("BoundedLruMap（字节预算有界 LRU 公共件）", () => {
  test("超预算逐出最旧端，命中触达改变逐出顺序", () => {
    const lru = new BoundedLruMap<string, string>({
      maxBytes: 10,
      bytesOf: value => value.length,
    });
    lru.set("a", "1234");
    lru.set("b", "1234");
    assert.equal(lru.totalBytes, 8);
    lru.set("c", "1234");
    // 预算 10：插入 c 后总量 12 → 逐出最旧的 a。
    assert.equal(lru.size, 2);
    assert.equal(lru.get("a"), undefined, "最旧条目必须被逐出");
    // 命中 b 重插到尾（顺序 [c, b]）：下一次插入逐出的是未触达的 c，不是 b。
    assert.equal(lru.get("b"), "1234");
    lru.set("d", "1234");
    assert.equal(lru.get("b"), "1234", "命中过的条目不得被先逐出");
    assert.equal(lru.get("c"), undefined, "未触达的较新条目按序逐出");
    assert.equal(lru.get("d"), "1234");
  });

  test("至少保留 1 条（单条自身超预算不发生自噬）", () => {
    const lru = new BoundedLruMap<string, string>({
      maxBytes: 1,
      bytesOf: value => value.length,
    });
    lru.set("big", "0123456789");
    assert.equal(lru.get("big"), "0123456789", "刚插入的条目必须可读");
    assert.equal(lru.size, 1);
    lru.set("another", "x");
    // 新条目更小，旧的超大条目被逐出。
    assert.equal(lru.get("big"), undefined);
    assert.equal(lru.get("another"), "x");
  });

  test("覆盖同键更新字节数并触达", () => {
    const lru = new BoundedLruMap<string, string>({
      maxBytes: 10,
      bytesOf: value => value.length,
    });
    lru.set("k", "12");
    lru.set("k", "12345");
    assert.equal(lru.totalBytes, 5, "覆盖后按新值计字节，不叠加旧值");
    lru.set("other", "1234");
    assert.equal(lru.get("k"), "12345");
    assert.equal(lru.delete("k"), true);
    assert.equal(lru.delete("k"), false);
    assert.equal(lru.totalBytes, 4);
  });
});
