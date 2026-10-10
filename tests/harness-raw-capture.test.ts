import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, open, readFile, rename, rm, stat, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { gzipSync } from "node:zlib";
import {
  appendRawCapturedExchangeV2,
  buildRawCapturedExchange,
  buildRawCapturedExchangeV2,
  createCaptureSessionId,
  createV2CaptureSessionId,
  hydrateRawCapturedExchange,
  readRawBodyText,
} from "../src/lib/harness/raw-capture.js";
import {
  reconstructStreamingResponseBody,
  responseBodyForDisplay,
  responseEvidenceBodyForDisplay,
  tokenUsageFromExchange,
} from "../src/lib/harness/stream-response.js";
import { parseSSEStream } from "../src/sse.js";
import type { RawCapturedExchangeV2 } from "../src/lib/harness/types.js";

const temporaryDataDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDataDirs.splice(0).map(dataDir => rm(dataDir, {
    recursive: true,
    force: true,
  })));
});

describe("MVP-A raw evidence capture", () => {
  test("v2 原始证据只保留 raw/ref，不落盘 parsedBody 和 SSE events", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-");
    const exchange = await buildRawCapturedExchangeV2(buildStreamingInput(dataDir));

    expect(exchange.schemaVersion).toBe(2);
    expect("parsedBody" in exchange.request).toBe(false);
    expect("parsedBody" in exchange.response).toBe(false);
    expect(exchange.stream).toBeUndefined();
    expect(exchange.response.rawBody || exchange.response.rawBodyRef).toBeTruthy();

    const first = await appendRawCapturedExchangeV2(dataDir, exchange);
    const second = await appendRawCapturedExchangeV2(dataDir, {
      ...exchange,
      exchangeId: `${exchange.captureSessionId}:ex-2`,
      sequence: 2,
    });
    const expectedFile = join(dataDir, "captures", "v2", `${exchange.captureSessionId}.jsonl`);
    const serialized = await readFile(expectedFile, "utf-8");

    expect(first.filePath).toBe(expectedFile);
    expect(first.byteOffset).toBe(0);
    expect(first.lineLengthBytes).toBe(Buffer.byteLength(`${JSON.stringify(exchange)}\n`));
    expect(second.filePath).toBe(expectedFile);
    expect(second.byteOffset).toBe(first.lineLengthBytes);
    expect(serialized).not.toContain('"parsedBody"');
    expect(serialized).not.toContain('"events"');
    expect(serialized.trim().split("\n")).toHaveLength(2);
  });

  test("v2 写入器只序列化白名单字段，忽略未知派生字段", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-snapshot-");
    const exchange = await buildRawCapturedExchangeV2(buildStreamingInput(dataDir));
    const contaminated = {
      ...exchange,
      normalized: { marker: "top-level-derived" },
      request: {
        ...exchange.request,
        normalizedRequest: "request-derived",
      },
      response: {
        ...exchange.response,
        derivedResponse: "response-derived",
      },
    };

    const result = await appendRawCapturedExchangeV2(dataDir, contaminated);
    const serialized = await readFile(result.filePath, "utf-8");

    expect(serialized).not.toContain("top-level-derived");
    expect(serialized).not.toContain("request-derived");
    expect(serialized).not.toContain("response-derived");
  });

  test("v2 写入器拒绝 v1 和已水合对象，防止解析副本重新落盘", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-invariant-");
    const input = buildStreamingInput(dataDir);
    const v1 = await buildRawCapturedExchange(input);
    const v2 = await buildRawCapturedExchangeV2(input);
    const hydrated = await hydrateRawCapturedExchange(dataDir, v2);

    await expect(appendRawCapturedExchangeV2(
      dataDir,
      v1 as unknown as RawCapturedExchangeV2,
    )).rejects.toThrow(
      "schemaVersion 2",
    );
    await expect(appendRawCapturedExchangeV2(
      dataDir,
      hydrated as unknown as RawCapturedExchangeV2,
    )).rejects.toThrow(
      "unhydrated raw evidence",
    );
    await expect(stat(join(dataDir, "captures", "v2"))).rejects.toThrow();
  });

  test("v2 同一 capture 并发追加会返回唯一且可反读的字节范围", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-concurrent-");
    const base = await buildRawCapturedExchangeV2(buildStreamingInput(dataDir));
    const exchanges = Array.from({ length: 24 }, (_, index) => ({
      ...base,
      exchangeId: `${base.captureSessionId}:ex-${index + 1}`,
      sequence: index + 1,
    }));

    const locations = await Promise.all(
      exchanges.map(exchange => appendRawCapturedExchangeV2(dataDir, exchange)),
    );
    const file = await readFile(locations[0]!.filePath);

    expect(new Set(locations.map(location => location.byteOffset)).size).toBe(exchanges.length);
    for (const [index, location] of locations.entries()) {
      const line = file.subarray(
        location.byteOffset,
        location.byteOffset + location.lineLengthBytes,
      ).toString("utf-8");
      expect(JSON.parse(line).exchangeId).toBe(exchanges[index]!.exchangeId);
    }
  });

  test("v2 追加使用 Buffer 循环写满，不能把单次短写当成功", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-short-write-");
    const exchange = await buildRawCapturedExchangeV2(buildStreamingInput(dataDir));
    const expected = Buffer.from(`${JSON.stringify(exchange)}\n`);

    await withPatchedFileHandleWrite(
      dataDir,
      (originalWrite, receiver, args) => writePartial(originalWrite, receiver, args),
      async () => {
        const result = await appendRawCapturedExchangeV2(dataDir, exchange);
        expect(result.lineLengthBytes).toBe(expected.length);
        expect(await readFile(result.filePath)).toEqual(expected);
      },
    );
  });

  test("v2 部分写失败会回滚，并允许队列后继从干净 offset 继续", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-write-recovery-");
    const first = await buildRawCapturedExchangeV2(buildStreamingInput(dataDir));
    const second = {
      ...first,
      exchangeId: `${first.captureSessionId}:ex-2`,
      sequence: 2,
    };
    let failNextWrite = true;

    await withPatchedFileHandleWrite(
      dataDir,
      async (originalWrite, receiver, args) => {
        if (!failNextWrite) return Reflect.apply(originalWrite, receiver, args);
        failNextWrite = false;
        await writePartial(originalWrite, receiver, args);
        throw new Error("模拟部分写失败");
      },
      async () => {
        await expect(appendRawCapturedExchangeV2(dataDir, first)).rejects.toThrow(
          "模拟部分写失败",
        );
        const result = await appendRawCapturedExchangeV2(dataDir, second);
        const serialized = await readFile(result.filePath, "utf-8");

        expect(result.byteOffset).toBe(0);
        expect(JSON.parse(serialized).exchangeId).toBe(second.exchangeId);
      },
    );
  });

  test("v2 回滚失败后阻断后继写入，直到 poisoned offset 恢复成功", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-poisoned-offset-");
    const first = await buildRawCapturedExchangeV2(buildStreamingInput(dataDir));
    const second = {
      ...first,
      exchangeId: `${first.captureSessionId}:ex-2`,
      sequence: 2,
    };
    const third = {
      ...first,
      exchangeId: `${first.captureSessionId}:ex-3`,
      sequence: 3,
    };
    let writeAttempts = 0;
    let truncateAttempts = 0;

    await withPatchedFileHandleMethods(
      dataDir,
      {
        write: async (originalWrite, receiver, args) => {
          writeAttempts += 1;
          if (writeAttempts !== 1) return Reflect.apply(originalWrite, receiver, args);
          await writePartial(originalWrite, receiver, args);
          throw new Error("模拟部分写失败");
        },
        truncate: async (originalTruncate, receiver, args) => {
          truncateAttempts += 1;
          if (truncateAttempts <= 2) throw new Error("模拟 truncate 失败");
          return Reflect.apply(originalTruncate, receiver, args);
        },
      },
      async () => {
        await expect(appendRawCapturedExchangeV2(dataDir, first)).rejects.toThrow(
          "rollback to byte offset 0 also failed",
        );
        await expect(appendRawCapturedExchangeV2(dataDir, second)).rejects.toThrow(
          "v2 raw capture recovery to byte offset 0 failed",
        );
        expect(writeAttempts).toBe(1);

        const result = await appendRawCapturedExchangeV2(dataDir, third);
        const serialized = await readFile(result.filePath, "utf-8");

        expect(result.byteOffset).toBe(0);
        expect(writeAttempts).toBe(2);
        // Windows 上恢复路径的首次真实 truncate 会因 append 句柄权限失败（EACCES），
        // truncateCaptureFile 经 r+ 句柄重试多消耗一次补丁计数（4 = 2 失败 + r+ 重试 + 成功）。
        expect(truncateAttempts).toBe(process.platform === "win32" ? 4 : 3);
        expect(serialized.trim().split("\n")).toHaveLength(1);
        expect(JSON.parse(serialized).exchangeId).toBe(third.exchangeId);
      },
    );
  });

  test("v2 追加在无进程状态时用固定小块倒序修复完整行后的半尾", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-partial-tail-");
    const exchange = await buildRawCapturedExchangeV2(buildStreamingInput(dataDir));
    const captureDir = join(dataDir, "captures", "v2");
    const filePath = join(captureDir, `${exchange.captureSessionId}.jsonl`);
    const completeLine = `${JSON.stringify({ exchangeId: "existing" })}\n`;
    const partialTail = Buffer.alloc(3 * 64 * 1024 + 17, "x");
    await mkdir(captureDir, { recursive: true });
    await writeFile(filePath, Buffer.concat([Buffer.from(completeLine), partialTail]));
    let readCalls = 0;
    let maxReadLength = 0;

    const result = await withPatchedFileHandleMethods(
      dataDir,
      {
        read: (originalRead, receiver, args) => {
          readCalls += 1;
          const requestedLength = typeof args[2] === "number" ? args[2] : 0;
          maxReadLength = Math.max(maxReadLength, requestedLength);
          return Reflect.apply(originalRead, receiver, args);
        },
      },
      () => appendRawCapturedExchangeV2(dataDir, exchange),
    );
    const serialized = await readFile(filePath, "utf-8");
    const lines = serialized.trimEnd().split("\n");

    expect(result.byteOffset).toBe(Buffer.byteLength(completeLine));
    expect(readCalls).toBeGreaterThan(2);
    expect(maxReadLength).toBeLessThanOrEqual(64 * 1024);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).exchangeId).toBe("existing");
    expect(JSON.parse(lines[1]!).exchangeId).toBe(exchange.exchangeId);
  });

  test("v2 追加在半尾中找不到换行时先归零", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-no-newline-");
    const exchange = await buildRawCapturedExchangeV2(buildStreamingInput(dataDir));
    const captureDir = join(dataDir, "captures", "v2");
    const filePath = join(captureDir, `${exchange.captureSessionId}.jsonl`);
    await mkdir(captureDir, { recursive: true });
    await writeFile(filePath, "partial-json-without-newline");

    const result = await appendRawCapturedExchangeV2(dataDir, exchange);
    const serialized = await readFile(filePath, "utf-8");

    expect(result.byteOffset).toBe(0);
    expect(serialized.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(serialized).exchangeId).toBe(exchange.exchangeId);
  });

  test("v2 capture Session ID 连续创建时保持唯一", () => {
    const zero = createV2CaptureSessionId(0);
    const first = createV2CaptureSessionId(1_752_643_200_000);
    const second = createV2CaptureSessionId(1_752_643_200_000);
    const defaultNow = createV2CaptureSessionId();

    expect(first).not.toBe(second);
    expect(zero).toMatch(/^capture-v2-0-[0-9a-f]{8}-[0-9a-f]{3}$/);
    expect(first).toMatch(/^capture-v2-1752643200000-[0-9a-f]{8}-[0-9a-f]{3}$/);
    expect(second).toMatch(/^capture-v2-1752643200000-[0-9a-f]{8}-[0-9a-f]{3}$/);
    expect(defaultNow).toMatch(/^capture-v2-\d+-[0-9a-f]{8}-[0-9a-f]{3}$/);
  });

  test("v2 capture Session ID 拒绝非法时间戳", () => {
    const invalidValues = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53];

    for (const now of invalidValues) {
      expect(() => createV2CaptureSessionId(now)).toThrow(
        "v2 capture Session ID timestamp must be a non-negative safe integer",
      );
    }
  });

  test("v2 原始证据仅在单条水合时生成解析字段和 SSE events", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-hydrate-");
    const exchange = await buildRawCapturedExchangeV2(buildStreamingInput(dataDir));

    const hydrated = await hydrateRawCapturedExchange(dataDir, exchange);

    expect(hydrated.request.parsedBody).toEqual({ model: "gpt-5.4", stream: true });
    expect(hydrated.response.parsedBody).toBeUndefined();
    expect(hydrated.stream?.events.map(event => event.event)).toEqual([
      "response.output_text.delta",
      "response.completed",
    ]);
    expect("parsedBody" in exchange.request).toBe(false);
    expect(exchange.stream).toBeUndefined();
  });

  test("v2 水合保留 routing.clientCredentialId 供派生读取密钥倍率", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-credential-");
    const exchange = await buildRawCapturedExchangeV2(buildStreamingInput(dataDir));
    exchange.routing.clientCredentialId = "cred_test_rate";

    const hydrated = await hydrateRawCapturedExchange(dataDir, exchange);

    expect(hydrated.routing.clientCredentialId).toBe("cred_test_rate");
  });

  test("v2 水合在解析前执行默认声明预算和更小显式 inline 预算", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-hydrate-budget-");
    const exchange = await buildRawCapturedExchangeV2(buildStreamingInput(dataDir));
    const oversizedDeclaration = {
      ...exchange,
      request: {
        ...exchange.request,
        rawBodyRef: {
          ...exchange.request.rawBodyRef!,
          sizeBytes: 8 * 1024 * 1024 + 1,
        },
      },
    };

    await expect(hydrateRawCapturedExchange(dataDir, oversizedDeclaration)).rejects.toThrow(
      "request raw body declared size 8388609 exceeds 8388608-byte hydration budget",
    );
    await expect(hydrateRawCapturedExchange(dataDir, exchange, { maxBytes: 16 })).rejects.toThrow(
      "request inline raw body size 33 exceeds 16-byte hydration budget",
    );
  });

  test("v2 水合在读取前限制外置压缩文件，并以硬上限阻断解压 bomb", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-hydrate-compressed-");
    const blobDir = join(dataDir, "blobs", "test");
    await mkdir(blobDir, { recursive: true });
    const oversizedFile = join(blobDir, "oversized.body.gz");
    await writeFile(oversizedFile, Buffer.alloc(256, 1));
    const bombFile = join(blobDir, "bomb.body.gz");
    const bomb = gzipSync("x".repeat(4096));
    await writeFile(bombFile, bomb);
    const base = await buildRawCapturedExchangeV2(buildSmallNonStreamingInput(dataDir));
    const withExternalRequest = (externalPath: string, compressedSizeBytes: number) => ({
      ...base,
      request: {
        ...base.request,
        rawBody: undefined,
        rawBodyRef: {
          storage: "external-blob" as const,
          encoding: "gzip" as const,
          sha256: "test",
          sizeBytes: 1,
          compressedSizeBytes,
          externalPath,
        },
      },
    });

    await expect(hydrateRawCapturedExchange(
      dataDir,
      withExternalRequest(join("blobs", "test", "oversized.body.gz"), 1),
      { maxBytes: 128 },
    )).rejects.toThrow(
      "request external compressed file size 256 exceeds 128-byte hydration budget",
    );
    await expect(hydrateRawCapturedExchange(
      dataDir,
      withExternalRequest(join("blobs", "test", "bomb.body.gz"), bomb.length),
      { maxBytes: 128 },
    )).rejects.toThrow(
      "request raw body decompressed output exceeds 128-byte hydration budget",
    );
  });

  test("v2 水合校验外置 blob 的压缩大小、解压大小和 SHA-256", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-integrity-");
    const blobDir = join(dataDir, "blobs", "test");
    await mkdir(blobDir, { recursive: true });
    const text = JSON.stringify({ integrity: true });
    const body = Buffer.from(text, "utf-8");
    const compressed = gzipSync(body);
    const blobPath = join(blobDir, "integrity.body.gz");
    await writeFile(blobPath, compressed);
    const base = await buildRawCapturedExchangeV2(buildSmallNonStreamingInput(dataDir));
    const hydrateWith = (overrides: Partial<NonNullable<typeof base.request.rawBodyRef>>) =>
      hydrateRawCapturedExchange(dataDir, {
        ...base,
        request: {
          ...base.request,
          rawBody: undefined,
          rawBodyRef: {
            storage: "external-blob",
            encoding: "gzip",
            sha256: createHash("sha256").update(body).digest("hex"),
            sizeBytes: body.length,
            compressedSizeBytes: compressed.length,
            externalPath: join("blobs", "test", "integrity.body.gz"),
            ...overrides,
          },
        },
      });

    await expect(hydrateWith({ compressedSizeBytes: compressed.length + 1 })).rejects.toThrow(
      "request raw body compressed size does not match its reference",
    );
    await expect(hydrateWith({ sizeBytes: body.length + 1 })).rejects.toThrow(
      "request raw body size does not match its reference",
    );
    await expect(hydrateWith({ sha256: "0".repeat(64) })).rejects.toThrow(
      "request raw body SHA-256 does not match its reference",
    );
  });

  test("v2 水合拒绝外置 blob 中的非法 UTF-8", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-utf8-");
    const blobDir = join(dataDir, "blobs", "test");
    await mkdir(blobDir, { recursive: true });
    const body = Buffer.from([0xc3, 0x28]);
    const compressed = gzipSync(body);
    await writeFile(join(blobDir, "invalid-utf8.body.gz"), compressed);
    const base = await buildRawCapturedExchangeV2(buildSmallNonStreamingInput(dataDir));

    await expect(hydrateRawCapturedExchange(dataDir, {
      ...base,
      request: {
        ...base.request,
        rawBody: undefined,
        rawBodyRef: {
          storage: "external-blob",
          encoding: "gzip",
          sha256: createHash("sha256").update(body).digest("hex"),
          sizeBytes: body.length,
          compressedSizeBytes: compressed.length,
          externalPath: join("blobs", "test", "invalid-utf8.body.gz"),
        },
      },
    })).rejects.toThrow("request raw body is not valid UTF-8");
  });

  test("v2 水合拒绝在安全检查后被替换的外置 blob", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-replaced-");
    const blobDir = join(dataDir, "blobs", "test");
    await mkdir(blobDir, { recursive: true });
    const originalBody = Buffer.from(JSON.stringify({ original: true }));
    const replacementBody = Buffer.from(JSON.stringify({ replacement: true }));
    const originalCompressed = gzipSync(originalBody);
    const blobPath = join(blobDir, "replace.body.gz");
    await writeFile(blobPath, originalCompressed);
    const base = await buildRawCapturedExchangeV2(buildSmallNonStreamingInput(dataDir));

    await expect(readRawBodyText(dataDir, {
      rawBodyRef: {
        storage: "external-blob",
        encoding: "gzip",
        sha256: createHash("sha256").update(originalBody).digest("hex"),
        sizeBytes: originalBody.length,
        compressedSizeBytes: originalCompressed.length,
        externalPath: join("blobs", "test", "replace.body.gz"),
      },
    }, {
      externalFileOpener: async (path: string, flags: number) => {
        const replacementPath = `${path}.replacement`;
        await writeFile(replacementPath, gzipSync(replacementBody));
        await rename(replacementPath, path);
        return open(path, flags);
      },
    })).rejects.toThrow("request external raw body changed during secure open");
  });

  test("v2 水合在安全检查后改成 symlink 时由 O_NOFOLLOW 拒绝", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-raced-symlink-");
    const blobDir = join(dataDir, "blobs", "test");
    await mkdir(blobDir, { recursive: true });
    const body = Buffer.from("{}");
    const compressed = gzipSync(body);
    const blobPath = join(blobDir, "race.body.gz");
    const outsidePath = join(dataDir, "outside-race.body.gz");
    await writeFile(blobPath, compressed);
    await writeFile(outsidePath, compressed);
    const error = await readRawBodyText(dataDir, {
      rawBodyRef: {
        storage: "external-blob",
        encoding: "gzip",
        sha256: createHash("sha256").update(body).digest("hex"),
        sizeBytes: body.length,
        compressedSizeBytes: compressed.length,
        externalPath: join("blobs", "test", "race.body.gz"),
      },
    }, {
      externalFileOpener: async (path: string, flags: number) => {
        await rm(path);
        await symlink(outsidePath, path);
        return open(path, flags);
      },
    }).then(() => undefined, reason => reason as NodeJS.ErrnoException);

    expect(error?.code).toBe(process.platform === "win32" ? "unsafe_raw_body_reference" : "ELOOP");
  });

  test("v2 水合拒绝安全检查后被替换但复用原文件 inode 的 blobs 根", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-raced-root-");
    const blobRoot = join(dataDir, "blobs");
    const blobDir = join(blobRoot, "test");
    await mkdir(blobDir, { recursive: true });
    const body = Buffer.from("{}");
    const compressed = gzipSync(body);
    const blobPath = join(blobDir, "root-race.body.gz");
    await writeFile(blobPath, compressed);
    const movedBlobRoot = join(dataDir, "moved-blobs");

    await expect(readRawBodyText(dataDir, {
      rawBodyRef: {
        storage: "external-blob",
        encoding: "gzip",
        sha256: createHash("sha256").update(body).digest("hex"),
        sizeBytes: body.length,
        compressedSizeBytes: compressed.length,
        externalPath: join("blobs", "test", "root-race.body.gz"),
      },
    }, {
      externalFileOpener: async (path: string, flags: number) => {
        await rename(blobRoot, movedBlobRoot);
        await mkdir(dirname(path), { recursive: true });
        await link(join(movedBlobRoot, "test", "root-race.body.gz"), path);
        return open(path, flags);
      },
    })).rejects.toThrow("request external raw body changed during secure open");
  });

  test("v2 水合在读取前拒绝越出 dataDir/blobs 的相对和绝对引用", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-hydrate-path-");
    const outsideFile = join(dataDir, "outside-proof.body.gz");
    await writeFile(outsideFile, gzipSync('{"mustNotRead":true}'));
    const base = await buildRawCapturedExchangeV2(buildSmallNonStreamingInput(dataDir));
    const withExternalPath = (externalPath: string) => ({
      ...base,
      request: {
        ...base.request,
        rawBody: undefined,
        rawBodyRef: {
          storage: "external-blob" as const,
          encoding: "gzip" as const,
          sha256: "outside-proof",
          sizeBytes: 20,
          compressedSizeBytes: 40,
          externalPath,
        },
      },
    });

    await expect(hydrateRawCapturedExchange(
      dataDir,
      withExternalPath(join("blobs", "..", "outside-proof.body.gz")),
    )).rejects.toThrow("request external raw body path must stay within dataDir/blobs");
    await expect(hydrateRawCapturedExchange(
      dataDir,
      withExternalPath(outsideFile),
    )).rejects.toThrow("request external raw body path must stay within dataDir/blobs");
  });

  test("v2 水合稳定报告缺失 blob，并拒绝 blobs 内指向目录外的符号链接", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-hydrate-realpath-");
    const blobDir = join(dataDir, "blobs", "test");
    await mkdir(blobDir, { recursive: true });
    const outsideFile = join(dataDir, "outside-proof.body.gz");
    await writeFile(outsideFile, gzipSync("{}"));
    await symlink(outsideFile, join(blobDir, "escape.body.gz"));
    const base = await buildRawCapturedExchangeV2(buildSmallNonStreamingInput(dataDir));
    const withExternalPath = (externalPath: string) => ({
      ...base,
      request: {
        ...base.request,
        rawBody: undefined,
        rawBodyRef: {
          storage: "external-blob" as const,
          encoding: "gzip" as const,
          sha256: "realpath-proof",
          sizeBytes: 2,
          compressedSizeBytes: 22,
          externalPath,
        },
      },
    });

    const missingError = await hydrateRawCapturedExchange(
      dataDir,
      withExternalPath(join("blobs", "test", "missing.body.gz")),
    ).then(() => undefined, reason => reason as NodeJS.ErrnoException);
    expect(missingError?.code).toBe("ENOENT");
    await expect(hydrateRawCapturedExchange(
      dataDir,
      withExternalPath(join("blobs", "test", "escape.body.gz")),
    )).rejects.toThrow("request external raw body path must stay within dataDir/blobs");
  });

  test("v2 水合拒绝逃逸 symlink 的 blobs 根，但允许 dataDir 自身是 symlink", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-blob-root-");
    const escapedBlobRoot = await buildTempDataDir("harness-raw-v2-escaped-blobs-");
    const escapedBody = join(escapedBlobRoot, "escaped.body.gz");
    await writeFile(escapedBody, gzipSync("{}"));
    await symlink(escapedBlobRoot, join(dataDir, "blobs"));
    const escaped = await buildRawCapturedExchangeV2(buildSmallNonStreamingInput(dataDir));
    const escapedReference = {
      ...escaped,
      request: {
        ...escaped.request,
        rawBody: undefined,
        rawBodyRef: {
          storage: "external-blob" as const,
          encoding: "gzip" as const,
          sha256: "escaped-root",
          sizeBytes: 2,
          compressedSizeBytes: (await stat(escapedBody)).size,
          externalPath: join("blobs", "escaped.body.gz"),
        },
      },
    };

    await expect(hydrateRawCapturedExchange(dataDir, escapedReference)).rejects.toThrow(
      "request external raw body root must stay within real dataDir/blobs",
    );

    const linkedFixture = await buildTempDataDir("harness-raw-v2-linked-data-");
    const realDataDir = join(linkedFixture, "real-data");
    const linkedDataDir = join(linkedFixture, "linked-data");
    const realBlobDir = join(realDataDir, "blobs", "test");
    await mkdir(realBlobDir, { recursive: true });
    await symlink(realDataDir, linkedDataDir);
    const linkedBody = join(realBlobDir, "linked.body.gz");
    const linkedCompressed = gzipSync("{}");
    await writeFile(linkedBody, linkedCompressed);
    const linked = await buildRawCapturedExchangeV2(buildSmallNonStreamingInput(linkedDataDir));
    const linkedReference = {
      ...linked,
      request: {
        ...linked.request,
        rawBody: undefined,
        rawBodyRef: {
          storage: "external-blob" as const,
          encoding: "gzip" as const,
          sha256: createHash("sha256").update("{}").digest("hex"),
          sizeBytes: 2,
          compressedSizeBytes: linkedCompressed.length,
          externalPath: join("blobs", "test", "linked.body.gz"),
        },
      },
    };

    const hydrated = await hydrateRawCapturedExchange(linkedDataDir, linkedReference);
    expect(hydrated.request.parsedBody).toEqual({});
  });

  test("v2 写入器在创建目录前拒绝所有非规范 capture Session ID", async () => {
    const dataDir = await buildTempDataDir("harness-raw-v2-invalid-id-");
    const invalidIds = [
      "A",
      "A/B",
      "a.b-deadbeefdead",
      "../../capture-v2-1752643200000-01234567-89a",
    ];

    for (const captureSessionId of invalidIds) {
      const exchange = await buildRawCapturedExchangeV2({
        ...buildStreamingInput(dataDir),
        captureSessionId,
      });
      await expect(appendRawCapturedExchangeV2(dataDir, exchange)).rejects.toThrow(
        "invalid v2 captureSessionId",
      );
    }
    await expect(stat(join(dataDir, "captures", "v2"))).rejects.toThrow();
  });

  test("builds RawCapturedExchange JSONL v1 with stable ids and inline raw bodies", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "harness-raw-inline-"));
    const captureSessionId = createCaptureSessionId(new Date("2026-05-31T10:00:00.000Z"), 1);
    const requestBody = '{"model":"gpt-5","input":"hello"}';
    const responseBody = '{"id":"resp_1","object":"response","status":"completed","output":[]}';

    const exchange = await buildRawCapturedExchange({
      dataDir,
      captureSessionId,
      sequence: 7,
      capturedAt: "2026-05-31T10:00:00.000Z",
      completedAt: "2026-05-31T10:00:01.234Z",
      routing: {
        targetId: "api.openai.com",
        targetName: "OpenAI",
        targetFormatHint: "openai",
        localUrl: "http://127.0.0.1:3211/api.openai.com/v1/responses",
        upstreamUrl: "https://api.openai.com/v1/responses",
        localPath: "/api.openai.com/v1/responses",
        upstreamPath: "/v1/responses",
        method: "POST",
      },
      request: {
        headers: { "content-type": "application/json" },
        rawBody: requestBody,
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        rawBody: responseBody,
        isStreaming: false,
      },
    });

    expect(exchange.schemaVersion).toBe(1);
    expect(exchange.exchangeId).toBe(`${captureSessionId}:ex-7`);
    expect(exchange.request.rawBody).toBe(requestBody);
    expect(exchange.response.rawBody).toBe(responseBody);
    expect(exchange.request.parsedBody).toEqual({ model: "gpt-5", input: "hello" });
    expect(exchange.response.parsedBody).toMatchObject({ id: "resp_1", object: "response" });
    expect(exchange.bodyStorage.policy).toBe("inline");
    expect(exchange.request.bodySha256).toHaveLength(64);
    expect(exchange.captureDiagnostics).toEqual([]);
  });

  test("stores large streaming raw body as external blob while preserving SSE events", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "harness-raw-external-"));
    const largeText = "x".repeat(2048);
    const rawSse = [
      "event: response.output_text.delta",
      `data: {"type":"response.output_text.delta","delta":"${largeText}"}`,
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","output":[]}}',
      "",
    ].join("\n");

    const exchange = await buildRawCapturedExchange({
      dataDir,
      captureSessionId: "capture-2026-05-31-001",
      sequence: 1,
      capturedAt: "2026-05-31T10:00:00.000Z",
      completedAt: "2026-05-31T10:00:02.000Z",
      rawBodyPolicy: {
        inlineThresholdBytes: 64,
        compressedInlineThresholdBytes: 128,
      },
      routing: {
        targetId: "api.openai.com",
        targetName: "OpenAI",
        targetFormatHint: "openai",
        localUrl: "http://127.0.0.1:3211/responses",
        upstreamUrl: "https://api.openai.com/responses",
        localPath: "/responses",
        upstreamPath: "/responses",
        method: "POST",
      },
      request: {
        headers: { "content-type": "application/json" },
        rawBody: "{}",
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/event-stream" },
        rawBody: rawSse,
        isStreaming: true,
      },
    });

    // 大 body（超过 compressedInlineThresholdBytes）外置 blob 存储，防止代理内存膨胀导致 OOM
    expect(exchange.response.rawBody).toBeUndefined();
    expect(exchange.response.rawBodyRef?.storage).toBe("external-blob");
    expect(exchange.response.rawBodyRef?.externalPath).toBeTruthy();
    expect(exchange.stream?.rawBodyStorage).toBe("external-blob");
    expect(exchange.stream?.events.map(event => event.event)).toEqual([
      "response.output_text.delta",
      "response.completed",
    ]);
    expect(exchange.stream?.doneMarkerSeen).toBe(false);

    const raw = await readRawBodyText(dataDir, exchange.response);
    expect(raw).toBe(rawSse);
  });

  test("reconstructs streaming response JSON for display and extracts provider token usage", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "harness-raw-stream-display-"));
    const rawSse = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","content_index":0,"delta":"Hel","item_id":"msg_1","output_index":0}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","content_index":0,"delta":"lo","item_id":"msg_1","output_index":0}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-5.4","output":[{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello","annotations":[]}]}],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
      "",
    ].join("\n");
    const exchange = await buildRawCapturedExchange({
      dataDir,
      captureSessionId: "capture-2026-05-31-001",
      sequence: 5,
      capturedAt: "2026-05-31T10:00:00.000Z",
      completedAt: "2026-05-31T10:00:02.000Z",
      routing: {
        targetId: "api.openai.com",
        targetName: "OpenAI",
        targetFormatHint: "openai",
        localUrl: "http://127.0.0.1:3211/responses",
        upstreamUrl: "https://api.openai.com/responses",
        localPath: "/responses",
        upstreamPath: "/responses",
        method: "POST",
      },
      request: {
        headers: { "content-type": "application/json" },
        rawBody: '{"model":"gpt-5.4","stream":true}',
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/event-stream" },
        rawBody: rawSse,
        isStreaming: true,
      },
    });

    expect(responseBodyForDisplay(exchange)).toMatchObject({
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Hello" }],
        },
      ],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    });
    expect(responseEvidenceBodyForDisplay(exchange)).toMatchObject({
      rawBody: {
        kind: "sse_stream",
        eventCount: 3,
      },
      reconstructedBody: {
        id: "resp_1",
      },
    });
    expect(tokenUsageFromExchange(exchange)).toMatchObject({
      inputTokens: 3,
      outputTokens: 2,
      totalInputTokens: 3,
      totalTokens: 5,
      source: "provider_usage",
    });
  });

  test("终止事件 output 压缩索引时不会重复流式工具调用", () => {
    const reconstructed = reconstructStreamingResponseBody("openai", [
      {
        index: 0,
        event: "response.output_item.added",
        rawData: "",
        data: {
          type: "response.output_item.added",
          output_index: 0,
          item: { id: "reasoning-1", type: "reasoning", summary: [] },
        },
      },
      {
        index: 1,
        event: "response.output_item.added",
        rawData: "",
        data: {
          type: "response.output_item.added",
          output_index: 1,
          item: {
            id: "message-1",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "准备调用工具" }],
          },
        },
      },
      {
        index: 2,
        event: "response.output_item.added",
        rawData: "",
        data: {
          type: "response.output_item.added",
          output_index: 2,
          item: {
            id: "function-1",
            type: "function_call",
            call_id: "call-1",
            name: "exec_command",
            arguments: "{}",
          },
        },
      },
      {
        index: 3,
        event: "response.completed",
        rawData: "",
        data: {
          type: "response.completed",
          response: {
            id: "response-1",
            object: "response",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "准备调用工具" }],
              },
              {
                type: "function_call",
                call_id: "call-1",
                name: "exec_command",
                arguments: "{}",
              },
            ],
          },
        },
      },
    ]);

    expect((reconstructed?.output as Array<{ type: string; call_id?: string }>))
      .toEqual([
        expect.objectContaining({ type: "message" }),
        expect.objectContaining({ type: "function_call", call_id: "call-1" }),
      ]);
  });

  test("keeps provider input tokens separate from cache-backed total input", () => {
    expect(tokenUsageFromExchange({
      exchangeId: "cache-usage",
      schemaVersion: 1,
      capturedAt: "2026-05-31T10:00:00.000Z",
      completedAt: "2026-05-31T10:00:01.000Z",
      durationMs: 1000,
      routing: {
        targetId: "api.anthropic.com",
        targetName: "Anthropic",
        targetFormatHint: "anthropic",
        localUrl: "http://127.0.0.1:3211/api.anthropic.com/v1/messages",
        upstreamUrl: "https://api.anthropic.com/v1/messages",
        localPath: "/api.anthropic.com/v1/messages",
        upstreamPath: "/v1/messages",
        method: "POST",
      },
      request: {
        headers: {},
        bodySizeBytes: 0,
        rawBody: "{}",
        parsedBody: {},
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: {},
        bodySizeBytes: 0,
        rawBody: "",
        parsedBody: {
          usage: {
            input_tokens: 808,
            cache_read_input_tokens: 124416,
            cache_creation_input_tokens: 0,
            output_tokens: 2042,
          },
        },
        isStreaming: false,
      },
      captureDiagnostics: [],
      security: {
        containsSensitiveHeaders: false,
        headerRedactionAppliedInApi: true,
        rawBodiesStoredLocally: true,
      },
    })).toMatchObject({
      inputTokens: 808,
      cacheReadTokens: 124416,
      cacheCreationTokens: 0,
      totalInputTokens: 125224,
      outputTokens: 2042,
    });
  });

  test("extracts nested OpenAI/GLM usage details without double counting cached input", () => {
    expect(tokenUsageFromExchange({
      exchangeId: "nested-usage",
      schemaVersion: 1,
      capturedAt: "2026-07-08T10:00:00.000Z",
      completedAt: "2026-07-08T10:00:01.000Z",
      durationMs: 1000,
      routing: {
        targetId: "bigmodel.cn",
        targetName: "BigModel",
        targetFormatHint: "openai",
        localUrl: "",
        upstreamUrl: "",
        localPath: "/v1/chat/completions",
        upstreamPath: "/v1/chat/completions",
        method: "POST",
      },
      request: {
        headers: {},
        bodySizeBytes: 0,
        rawBody: "{}",
        parsedBody: {},
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: {},
        bodySizeBytes: 0,
        rawBody: "",
        parsedBody: {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 130,
            prompt_tokens_details: { cached_tokens: 40 },
            completion_tokens_details: { reasoning_tokens: 10 },
          },
        },
        isStreaming: false,
      },
      captureDiagnostics: [],
      security: {
        containsSensitiveHeaders: false,
        headerRedactionAppliedInApi: true,
        rawBodiesStoredLocally: true,
      },
    })).toMatchObject({
      inputTokens: 60,
      cacheReadTokens: 40,
      totalInputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 10,
      totalTokens: 130,
      source: "provider_usage",
    });
  });

  test("normalizes DeepSeek and relay cache hit/miss usage without double counting input", () => {
    expect(tokenUsageFromExchange({
      exchangeId: "deepseek-cache-usage",
      captureSessionId: "cap",
      sequence: 1,
      capturedAt: "2026-07-09T00:00:00.000Z",
      completedAt: "2026-07-09T00:00:01.000Z",
      durationMs: 1000,
      routing: { targetId: "deepseek", targetName: "DeepSeek", targetFormatHint: "openai", localUrl: "", upstreamUrl: "", localPath: "/v1/chat/completions", upstreamPath: "/v1/chat/completions", method: "POST" },
      request: { headers: {}, rawBody: "{}", parsedBody: { model: "deepseek-v4-pro", messages: [] }, bodySizeBytes: 2, bodySha256: "" },
      response: {
        status: 200,
        statusText: "OK",
        headers: {},
        rawBody: "",
        parsedBody: {
          choices: [],
          usage: {
            prompt_tokens: 1500,
            prompt_cache_hit_tokens: 900,
            prompt_cache_miss_tokens: 600,
            completion_tokens: 120,
            total_tokens: 1620,
          },
        },
        bodySizeBytes: 0,
        bodySha256: "",
        isStreaming: false,
      },
      bodyStorage: { policy: "inline" },
      captureDiagnostics: [],
      security: { containsSensitiveHeaders: false, headerRedactionAppliedInApi: true, rawBodiesStoredLocally: true },
    })).toMatchObject({
      inputTokens: 600,
      totalInputTokens: 1500,
      cacheReadTokens: 900,
      outputTokens: 120,
      totalTokens: 1620,
      source: "provider_usage",
      usageConfidence: "exact",
    });
  });

  test("缺失 usage 的超长请求体走字符估算，不触发 gpt-tokenizer 病态耗时", () => {
    // 回归保护：gpt-tokenizer 的 BPE 对超长文本（尤其重复字符）耗时超线性，
    // 实测 200KB 约 83 秒，会同步阻塞 SQLite worker 事件循环；修复前该用例会卡死。
    const huge = "x".repeat(200 * 1024);
    const started = Date.now();
    const usage = tokenUsageFromExchange({
      exchangeId: "huge-no-usage",
      schemaVersion: 1,
      capturedAt: "2026-07-08T10:00:00.000Z",
      completedAt: "2026-07-08T10:00:01.000Z",
      durationMs: 1000,
      routing: {
        targetId: "target-huge",
        targetName: "Target",
        targetFormatHint: "openai",
        localUrl: "http://127.0.0.1:3211/v1/responses",
        upstreamUrl: "https://target.test/v1/responses",
        localPath: "/v1/responses",
        upstreamPath: "/v1/responses",
        method: "POST",
      },
      request: {
        headers: {},
        bodySizeBytes: Buffer.byteLength(huge),
        rawBody: huge,
        parsedBody: huge,
      },
      response: {
        status: 502,
        statusText: "Bad Gateway",
        headers: {},
        bodySizeBytes: 23,
        rawBody: '{"error":"Bad Gateway"}',
        parsedBody: { error: "Bad Gateway" },
        isStreaming: false,
      },
      captureDiagnostics: [],
      security: {
        containsSensitiveHeaders: false,
        headerRedactionAppliedInApi: true,
        rawBodiesStoredLocally: true,
      },
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5_000);
    expect(usage).toMatchObject({ source: "tokenizer_estimated" });
    expect(usage?.inputTokens).toBe(Math.ceil(huge.length / 4));
  });

  test("records parse diagnostics for invalid JSON and empty parsed SSE", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "harness-raw-diagnostics-"));
    const exchange = await buildRawCapturedExchange({
      dataDir,
      captureSessionId: "capture-2026-05-31-001",
      sequence: 2,
      capturedAt: "2026-05-31T10:00:00.000Z",
      completedAt: "2026-05-31T10:00:00.500Z",
      routing: {
        targetId: "api.anthropic.com",
        targetName: "Anthropic",
        targetFormatHint: "anthropic",
        localUrl: "http://127.0.0.1:3211/v1/messages",
        upstreamUrl: "https://api.anthropic.com/v1/messages",
        localPath: "/v1/messages",
        upstreamPath: "/v1/messages",
        method: "POST",
      },
      request: {
        headers: { "content-type": "application/json" },
        rawBody: "{bad json",
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/event-stream" },
        rawBody: ": keepalive\n\n",
        isStreaming: true,
      },
    });

    expect(exchange.request.parseError?.message).toContain("JSON");
    expect(exchange.captureDiagnostics.map(item => item.code)).toContain("request_json_parse_failed");
    expect(exchange.captureDiagnostics.map(item => item.code)).toContain("sse_parse_empty");
    expect(exchange.stream?.events).toEqual([]);
  });

  test("parseSSEStream keeps DONE marker and event parse errors for diagnostics", () => {
    const parsed = parseSSEStream([
      "data: {bad json",
      "",
      "data: [DONE]",
      "",
    ].join("\n"));

    expect(parsed.doneMarkerSeen).toBe(true);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]?.event).toBe("parse_error");
    expect(parsed.parseErrors[0]?.rawPreview).toContain("{bad json");
  });

  test("records client and upstream abort diagnostics separately", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "harness-raw-abort-"));
    const clientAbort = await buildRawCapturedExchange({
      dataDir,
      captureSessionId: "capture-2026-05-31-001",
      sequence: 3,
      capturedAt: "2026-05-31T10:00:00.000Z",
      completedAt: "2026-05-31T10:00:00.200Z",
      connectionStatus: "client_aborted",
      routing: minimalRouting(),
      request: { headers: {}, rawBody: "{}" },
      response: {
        status: 499,
        statusText: "Client Closed Request",
        headers: { "content-type": "text/event-stream" },
        rawBody: "event: message_start\ndata: {\"type\":\"message_start\"}\n\n",
        isStreaming: true,
      },
    });
    const upstreamAbort = await buildRawCapturedExchange({
      dataDir,
      captureSessionId: "capture-2026-05-31-001",
      sequence: 4,
      capturedAt: "2026-05-31T10:00:00.000Z",
      completedAt: "2026-05-31T10:00:00.200Z",
      connectionStatus: "upstream_aborted",
      routing: minimalRouting(),
      request: { headers: {}, rawBody: "{}" },
      response: {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "content-type": "text/event-stream" },
        rawBody: "event: message_start\ndata: {\"type\":\"message_start\"}\n\n",
        isStreaming: true,
      },
    });

    expect(clientAbort.captureDiagnostics.map(item => item.code)).toContain("client_aborted");
    expect(upstreamAbort.captureDiagnostics.map(item => item.code)).toContain("upstream_aborted");
  });
});

function minimalRouting() {
  return {
    targetId: "api.anthropic.com",
    targetName: "Anthropic",
    targetFormatHint: "anthropic" as const,
    localUrl: "http://127.0.0.1:3211/v1/messages",
    upstreamUrl: "https://api.anthropic.com/v1/messages",
    localPath: "/v1/messages",
    upstreamPath: "/v1/messages",
    method: "POST",
  };
}

async function buildTempDataDir(prefix: string): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  temporaryDataDirs.push(dataDir);
  return dataDir;
}

type ReflectedFileHandleMethod = (...args: unknown[]) => Promise<unknown>;
type FileHandleMethodName = "read" | "truncate" | "write";
type FileHandleMethodReplacement = (
  originalMethod: ReflectedFileHandleMethod,
  receiver: unknown,
  args: unknown[],
) => Promise<unknown>;

async function withPatchedFileHandleWrite<T>(
  dataDir: string,
  replacement: (
    originalWrite: ReflectedFileHandleMethod,
    receiver: unknown,
    args: unknown[],
  ) => Promise<unknown>,
  run: () => Promise<T>,
): Promise<T> {
  return withPatchedFileHandleMethods(dataDir, { write: replacement }, run);
}

async function withPatchedFileHandleMethods<T>(
  dataDir: string,
  replacements: Partial<Record<FileHandleMethodName, FileHandleMethodReplacement>>,
  run: () => Promise<T>,
): Promise<T> {
  const probe = await open(join(dataDir, "file-handle-probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as object;
  const originals = new Map<FileHandleMethodName, ReflectedFileHandleMethod>();
  await probe.close();
  for (const [methodName, replacement] of Object.entries(replacements) as Array<
    [FileHandleMethodName, FileHandleMethodReplacement]
  >) {
    const originalMethod = Reflect.get(prototype, methodName) as ReflectedFileHandleMethod;
    originals.set(methodName, originalMethod);
    Reflect.set(prototype, methodName, function (this: unknown, ...args: unknown[]) {
      return replacement(originalMethod, this, args);
    });
  }
  try {
    return await run();
  } finally {
    for (const [methodName, originalMethod] of originals) {
      Reflect.set(prototype, methodName, originalMethod);
    }
  }
}

async function writePartial(
  originalWrite: ReflectedFileHandleMethod,
  receiver: unknown,
  args: unknown[],
): Promise<unknown> {
  const data = args[0];
  if (typeof data !== "string" && !(data instanceof Uint8Array)) {
    throw new Error("测试仅支持 string 或 Uint8Array 写入。 ");
  }
  const source = typeof data === "string"
    ? Buffer.from(data, typeof args[2] === "string" ? args[2] as BufferEncoding : "utf-8")
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const offset = typeof data === "string" || typeof args[1] !== "number" ? 0 : args[1];
  const length = typeof data === "string" || typeof args[2] !== "number" ? source.length : args[2];
  const requested = source.subarray(offset, offset + length);
  const partial = requested.subarray(0, Math.max(1, Math.ceil(requested.length / 2)));
  return Reflect.apply(originalWrite, receiver, [partial, 0, partial.length, null]);
}

function buildStreamingInput(dataDir: string) {
  const rawBody = [
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","delta":"Hello"}',
    "",
    "event: response.completed",
    'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}',
    "",
  ].join("\n");
  return {
    dataDir,
    captureSessionId: "capture-v2-1752643200000-01234567-89a",
    sequence: 1,
    capturedAt: "2026-07-16T10:00:00.000Z",
    completedAt: "2026-07-16T10:00:01.000Z",
    routing: minimalRouting(),
    request: {
      headers: { "content-type": "application/json" },
      rawBody: '{"model":"gpt-5.4","stream":true}',
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/event-stream" },
      rawBody,
      isStreaming: true,
    },
  };
}

function buildSmallNonStreamingInput(dataDir: string) {
  return {
    ...buildStreamingInput(dataDir),
    request: {
      headers: { "content-type": "application/json" },
      rawBody: "{}",
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      rawBody: "{}",
      isStreaming: false,
    },
  };
}

test("estimates token usage with tokenizer when provider usage is missing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "harness-token-estimate-"));
  const exchange = await buildRawCapturedExchange({
    dataDir,
    captureSessionId: "capture-2026-05-31-001",
    sequence: 10,
    capturedAt: "2026-05-31T10:00:00.000Z",
    completedAt: "2026-05-31T10:00:01.000Z",
    routing: {
      targetId: "api.openai.com",
      targetName: "OpenAI",
      targetFormatHint: "openai",
      localUrl: "http://127.0.0.1:3211/v1/responses",
      upstreamUrl: "https://api.openai.com/v1/responses",
      localPath: "/v1/responses",
      upstreamPath: "/v1/responses",
      method: "POST",
    },
    request: {
      headers: { "content-type": "application/json" },
      rawBody: JSON.stringify({
        model: "gpt-5",
        messages: [{ role: "user", content: "Hello, world!" }],
      }),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      rawBody: JSON.stringify({
        id: "resp_1",
        object: "response",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "Hi there!" }] }],
      }),
      isStreaming: false,
    },
  });

  const usage = tokenUsageFromExchange(exchange);
  expect(usage.source).toBe("tokenizer_estimated");
  expect(usage.usageConfidence).toBe("medium");
  expect(usage.sourceLabel).toContain("估算");
  expect(usage.inputTokens).toBeGreaterThan(0);
  expect(usage.outputTokens).toBeGreaterThan(0);
  expect(usage.totalTokens).toBe(usage.inputTokens! + usage.outputTokens!);
});

test("returns unavailable when both provider usage and tokenizable content are missing", () => {
  expect(tokenUsageFromExchange({
    exchangeId: "empty",
    schemaVersion: 1,
    capturedAt: "2026-05-31T10:00:00.000Z",
    completedAt: "2026-05-31T10:00:01.000Z",
    durationMs: 1000,
    routing: {
      targetId: "test",
      targetName: "test",
      targetFormatHint: "openai",
      localUrl: "",
      upstreamUrl: "",
      localPath: "",
      upstreamPath: "",
      method: "POST",
    },
    request: {
      headers: {},
      bodySizeBytes: 0,
      rawBody: "",
      parsedBody: undefined,
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: {},
      bodySizeBytes: 0,
      rawBody: "",
      parsedBody: undefined,
      isStreaming: false,
    },
    captureDiagnostics: [],
    security: {
      containsSensitiveHeaders: false,
      headerRedactionAppliedInApi: true,
      rawBodiesStoredLocally: true,
    },
  })).toMatchObject({
    source: "unavailable",
  });
});
