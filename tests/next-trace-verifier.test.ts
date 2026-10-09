import {spawn} from "node:child_process";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, relative, resolve} from "node:path";
import {afterEach, describe, expect, test} from "vitest";

const rootDir = resolve(import.meta.dirname, "..");
const normalizerPath = join(rootDir, "scripts", "normalize-next-trace.mjs");
const verifierPath = join(rootDir, "scripts", "verify-next-trace.mjs");
const fixtureRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...fixtureRoots].map(path => rm(path, {recursive: true, force: true})));
  fixtureRoots.clear();
});

describe("Next NFT 追踪门禁", () => {
  test("规范化 instrumentation 清单时只移除项目运行时状态和源码", async () => {
    const fixture = await createTraceFixture({
      instrumentationExtras: [
        "data/blobs/aa/example.body.gz",
        "data/captures/v2/example.jsonl",
        "data/config/model-pricing.json",
        "data/deepaa.sqlite",
        "src/lib/pricing.ts",
        "src/app/api/captures/exchanges/route.ts",
        "tests/pricing.test.ts",
        "next.config.ts",
        "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      ],
    });

    const result = await runScript(normalizerPath, fixture.rootDir);

    expect(result).toMatchObject({code: 0, stderr: ""});
    expect(result.stdout).toContain("Next trace normalization completed");
    const files = await readResolvedTraceFiles(fixture.instrumentationManifest);
    expect(files).toContain(join(fixture.rootDir, ".next", "server", "chunks", "instrumentation.js"));
    expect(files).toContain(join(
      fixture.rootDir,
      "data",
      "defaults",
      "litellm-model-prices.snapshot.json",
    ));
    expect(files).toContain(join(
      fixture.rootDir,
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node",
    ));
    expect(files.some(path => path.startsWith(join(fixture.rootDir, "data", "blobs")))).toBe(false);
    expect(files.some(path => path.startsWith(join(fixture.rootDir, "data", "captures")))).toBe(false);
    expect(files.some(path => path.startsWith(join(fixture.rootDir, "src")))).toBe(false);
    expect(files.some(path => path.startsWith(join(fixture.rootDir, "tests")))).toBe(false);
    expect(files).not.toContain(join(fixture.rootDir, "data", "config", "model-pricing.json"));
    expect(files).not.toContain(join(fixture.rootDir, "data", "deepaa.sqlite"));
    expect(files).not.toContain(join(fixture.rootDir, "next.config.ts"));
    expect(await runVerifier(fixture.rootDir)).toMatchObject({code: 0, stderr: ""});
  });

  test("运行时数据路径禁止 Turbopack 从 dataDir 扩散枚举", async () => {
    const [processorSource, pricingSource, connectionSource, nextConfigSource] = await Promise.all([
      readFile(join(rootDir, "src", "lib", "ingestion", "exchange-processor.ts"), "utf8"),
      readFile(join(rootDir, "src", "lib", "pricing.ts"), "utf8"),
      readFile(join(rootDir, "src", "lib", "db", "connection.ts"), "utf8"),
      readFile(join(rootDir, "next.config.ts"), "utf8"),
    ]);

    expect(processorSource).toMatch(/join\(\s*\/\* turbopackIgnore: true \*\/ dataDir/u);
    expect(processorSource).toMatch(/stat\(\s*\/\* turbopackIgnore: true \*\/ join\(/u);
    expect(pricingSource).toMatch(/readFile\(\s*\/\* turbopackIgnore: true \*\/ join\(/u);
    expect(pricingSource).toContain("join(/* turbopackIgnore: true */ dataDir, USER_PRICING_FILE)");
    expect(pricingSource).toContain("open(/* turbopackIgnore: true */ filePath, \"r\")");
    expect(connectionSource).toContain("join(/* turbopackIgnore: true */ dataDir, \"deepaa.sqlite\")");
    expect(connectionSource).toMatch(
      /new DeepaaDatabase\(\s*\/\* turbopackIgnore: true \*\/ deepaaDatabasePath\(options\.dataDir\)/u,
    );
    expect(nextConfigSource).toContain("outputFileTracingExcludes");
    for (const excludedPath of [
      "./data/blobs/**/*",
      "./data/captures/**/*",
      "./data/config/**/*",
      "./data/*.sqlite*",
      "./data/proxy-config.json",
      "./data/proxy-routing-status.json",
      "./src/**/*",
      "./tests/**/*",
      "./next.config.ts",
    ]) {
      expect(nextConfigSource).toContain(`\"${excludedPath}\"`);
    }
  });

  test("接受只包含发布快照和构建产物的清单", async () => {
    const fixture = await createTraceFixture();

    const result = await runVerifier(fixture.rootDir);

    expect(result).toMatchObject({code: 0, stderr: ""});
    expect(result.stdout).toContain("Next trace verification passed");
  });

  test("拒绝未追踪发布快照的价格运行入口", async () => {
    const fixture = await createTraceFixture({includeSnapshot: false});

    const result = await runVerifier(fixture.rootDir);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("litellm-model-prices.snapshot.json");
  });

  test("拒绝 next.config、业务数据和无关 API 被意外纳入", async () => {
    const fixture = await createTraceFixture({
      routeExtras: [
        "next.config.ts",
        "data/blobs/aa/example.body.gz",
        "src/app/api/agents/route.ts",
      ],
    });

    const result = await runVerifier(fixture.rootDir);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("next.config.ts");
    expect(result.stderr).toContain("data/blobs/aa/example.body.gz");
    expect(result.stderr).toContain("src/app/api/agents/route.ts");
  });
});

interface TraceFixtureOptions {
  includeSnapshot?: boolean;
  instrumentationExtras?: string[];
  routeExtras?: string[];
}

async function createTraceFixture(options: TraceFixtureOptions = {}) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "deepaa-next-trace-"));
  fixtureRoots.add(fixtureRoot);
  const snapshotPath = join(
    fixtureRoot,
    "data",
    "defaults",
    "litellm-model-prices.snapshot.json",
  );
  const routeManifest = join(
    fixtureRoot,
    ".next",
    "server",
    "app",
    "api",
    "model-pricing",
    "import",
    "route.js.nft.json",
  );
  const instrumentationManifest = join(
    fixtureRoot,
    ".next",
    "server",
    "instrumentation.js.nft.json",
  );
  await Promise.all([
    mkdir(dirname(snapshotPath), {recursive: true}),
    mkdir(dirname(routeManifest), {recursive: true}),
    mkdir(dirname(instrumentationManifest), {recursive: true}),
  ]);
  await writeFile(snapshotPath, "{}", "utf8");

  const routeFiles = [join(fixtureRoot, ".next", "server", "chunks", "pricing.js")];
  const instrumentationFiles = [join(fixtureRoot, ".next", "server", "chunks", "instrumentation.js")];
  if (options.includeSnapshot !== false) {
    routeFiles.push(snapshotPath);
    instrumentationFiles.push(snapshotPath);
  }
  for (const extra of options.instrumentationExtras || []) {
    instrumentationFiles.push(join(fixtureRoot, extra));
  }
  for (const extra of options.routeExtras || []) {
    routeFiles.push(join(fixtureRoot, extra));
  }
  await Promise.all([
    writeTraceManifest(routeManifest, routeFiles),
    writeTraceManifest(instrumentationManifest, instrumentationFiles),
  ]);
  return {rootDir: fixtureRoot, instrumentationManifest, routeManifest};
}

async function writeTraceManifest(manifestPath: string, files: string[]): Promise<void> {
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      files: files.map(path => relative(dirname(manifestPath), path)),
    }),
    "utf8",
  );
}

function runVerifier(traceRoot: string): Promise<{code: number; stdout: string; stderr: string}> {
  return runScript(verifierPath, traceRoot);
}

async function readResolvedTraceFiles(manifestPath: string): Promise<string[]> {
  const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as {files: string[]};
  return parsed.files.map(path => resolve(dirname(manifestPath), path));
}

function runScript(
  scriptPath: string,
  traceRoot: string,
): Promise<{code: number; stdout: string; stderr: string}> {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [scriptPath, "--root", traceRoot], {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("exit", code => resolvePromise({code: code ?? 1, stdout, stderr}));
  });
}
