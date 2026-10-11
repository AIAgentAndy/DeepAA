import {describe, expect, test} from "vitest";
import {mkdtemp, readFile, readdir, rm, writeFile} from "fs/promises";
import {tmpdir} from "os";
import {join} from "path";
import {RawBodyCollector} from "../src/proxy/raw-body-collector.js";
import {atomicWriteFile, isTransientLockRenameError} from "../src/proxy/atomic-file.js";

const tempRoots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe("代理 raw 写入防护（2026-10-11 修复）", () => {
  test.afterAll(async () => {
    await Promise.all(tempRoots.splice(0).map(path => rm(path, {recursive: true, force: true})));
  });

  test("RawBodyCollector：finish 后到达的尾块丢弃计数，绝不抛错（进程崩溃回归）", async () => {
    // 2026-10-11 Windows 事故：上游流被中途销毁后，解码器/套接字缓冲尾块在
    // finish() 之后到达，capture() 抛错逃逸进流事件回调杀死整个代理进程。
    const dataDir = await tempDir("raw-collector-finish-");
    const collector = await RawBodyCollector.create({dataDir});
    collector.capture(Buffer.from("hello"));
    const finishPromise = collector.finish();
    // finish 置位后（未 await）到达的尾块：不抛错。
    collector.capture(Buffer.from("tail"));
    const result = await finishPromise;
    expect(result.missing).toBe(false);
    expect(result.rawBody).toBe("hello");
    // finish 完成后的迟到尾块：同样不抛错，全部计数。
    collector.capture(Buffer.from("late"));
    expect(collector.droppedAfterFinishBytes).toBe("tail".length + "late".length);
  });

  test("atomicWriteFile：写入与覆写后目录内无临时残留", async () => {
    const root = await tempDir("atomic-write-");
    const target = join(root, "status.json");
    await atomicWriteFile(target, "{\"revision\":1}");
    expect((await readFile(target, "utf8")).trim()).toBe("{\"revision\":1}");
    await atomicWriteFile(target, "{\"revision\":2}");
    expect((await readFile(target, "utf8")).trim()).toBe("{\"revision\":2}");
    const entries = (await readdir(root)).filter(name => name.includes(".tmp-"));
    expect(entries).toEqual([]);
  });

  test("atomicWriteFile：既有内容被覆盖时目标文件保持完整可读", async () => {
    const root = await tempDir("atomic-overwrite-");
    const target = join(root, "config.json");
    await writeFile(target, "{\"old\":true}", "utf8");
    await atomicWriteFile(target, "{\"new\":true}");
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({new: true});
  });

  test("瞬态锁错误码判定：EPERM/EBUSY/EACCES 可重试，其余不重试", () => {
    expect(isTransientLockRenameError(Object.assign(new Error("x"), {code: "EPERM"}))).toBe(true);
    expect(isTransientLockRenameError(Object.assign(new Error("x"), {code: "EBUSY"}))).toBe(true);
    expect(isTransientLockRenameError(Object.assign(new Error("x"), {code: "EACCES"}))).toBe(true);
    expect(isTransientLockRenameError(Object.assign(new Error("x"), {code: "ENOENT"}))).toBe(false);
    expect(isTransientLockRenameError(new Error("no code"))).toBe(false);
    expect(isTransientLockRenameError(undefined)).toBe(false);
  });
});
