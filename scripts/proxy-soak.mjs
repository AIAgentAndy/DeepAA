#!/usr/bin/env node

import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {once} from "node:events";
import {createReadStream, existsSync, realpathSync} from "node:fs";
import {access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from "node:fs/promises";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {dirname, isAbsolute, join, relative, resolve} from "node:path";
import {performance} from "node:perf_hooks";
import {createInterface} from "node:readline";
import {fileURLToPath} from "node:url";
import {gunzipSync} from "node:zlib";

const DAY_MS = 24 * 60 * 60 * 1_000;
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = join(rootDir, "dist", "proxy", "proxy-server.mjs");
const SOAK_TARGET_ID = "soak-target";
const SOAK_MODEL_ID = "soak-model";
const SOAK_CREDENTIAL_ID = "soak-cred";

export function parseSoakArguments(args) {
  const result = {
    durationMs: DAY_MS,
    requestLimit: Number.POSITIVE_INFINITY,
    concurrency: 32,
    reportIntervalMs: 60_000,
    sseEvery: 100,
    sseDelayMs: 1_000,
    largeEvery: 0,
    largeBodyBytes: 1024 * 1024,
    keepData: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--keep-data") {
      result.keepData = true;
      continue;
    }
    const raw = args[++index];
    if (raw === undefined) throw new Error(`${name} 缺少参数值`);
    switch (name) {
      case "--duration-ms": result.durationMs = positiveInteger(raw, "duration-ms"); break;
      case "--requests": result.requestLimit = positiveInteger(raw, "requests"); break;
      case "--concurrency": result.concurrency = boundedInteger(raw, "concurrency", 1, 256); break;
      case "--report-ms": result.reportIntervalMs = positiveInteger(raw, "report-ms"); break;
      case "--sse-every": result.sseEvery = positiveInteger(raw, "sse-every"); break;
      case "--sse-delay-ms": result.sseDelayMs = positiveInteger(raw, "sse-delay-ms"); break;
      case "--large-every": result.largeEvery = positiveInteger(raw, "large-every"); break;
      case "--large-body-bytes": result.largeBodyBytes = positiveInteger(raw, "large-body-bytes"); break;
      default: throw new Error(`unknown soak option: ${name}`);
    }
  }
  return result;
}

/** 构造与真实网关一致的 V3 soak 配置；Agent 接入状态不限制手工 3211 请求。 */
export function buildSoakRuntimeConfig(upstreamUrl) {
  return {
    version: 3,
    revision: 1,
    agentConnections: {},
    targets: [{
      id: SOAK_TARGET_ID,
      name: "Proxy soak fixture",
      openaiUrl: upstreamUrl,
      enabled: true,
      supportedModels: [SOAK_MODEL_ID],
      development: {defaultCredentials: {codex: SOAK_CREDENTIAL_ID}},
    }],
    localProxyBaseUrl: "http://127.0.0.1:3211",
    updatedAt: new Date().toISOString(),
  };
}

/** 所有 soak 流量使用同一个受支持的 Responses 路径，通过请求标记区分响应形态。 */
export function createSoakRequest(id, options) {
  const streaming = id % options.sseEvery === 0;
  const large = !streaming
    && options.largeEvery > 0
    && id % options.largeEvery === 0;
  return {
    path: "/codex/v1/responses",
    streaming,
    large,
    headers: {
      "content-type": "application/json",
      accept: streaming ? "text/event-stream" : "application/json",
      ...(large ? {"x-deepaa-soak-large": "1"} : {}),
    },
    body: {
      model: `${SOAK_MODEL_ID}_${SOAK_TARGET_ID}`,
      input: id,
      stream: streaming,
      ...(large ? {payload: "x".repeat(options.largeBodyBytes)} : {}),
    },
  };
}

export async function runProxySoak(options = parseSoakArguments(process.argv.slice(2))) {
  await access(bundlePath).catch(() => {
    throw new Error("缺少 dist/proxy/proxy-server.mjs，请先运行 pnpm build:proxy");
  });
  const runtimeRoot = await mkdtemp(join(tmpdir(), "deepaa-proxy-soak-"));
  const dataDir = join(runtimeRoot, "data");
  const upstream = createFixtureServer(options);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("soak upstream 未监听 TCP 端口");
  await mkdir(dataDir, {recursive: true});
  await writeFile(
    join(dataDir, "proxy-config.json"),
    `${JSON.stringify(buildSoakRuntimeConfig(`http://127.0.0.1:${upstreamAddress.port}/v1`), null, 2)}\n`,
    "utf8",
  );
  const credentialHelperPath = join(runtimeRoot, "credential-helper.sh");
  await writeFile(credentialHelperPath, "#!/bin/sh\nprintf 'soak-token\\n'\n", "utf8");
  await chmod(credentialHelperPath, 0o700);

  const proxy = spawn(process.execPath, [bundlePath], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      DEEPAA_DATA_DIR: dataDir,
      DEEPAA_CREDENTIAL_HELPER: credentialHelperPath,
      PROXY_HOST: "127.0.0.1",
      PROXY_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const proxyEvents = observeProxyEvents(proxy);
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const stats = {
    started: 0,
    completed: 0,
    failed: 0,
    sseCompleted: 0,
    firstByte: new LatencyHistogram(),
    total: new LatencyHistogram(),
    rss: {firstKiB: undefined, lastKiB: undefined, peakKiB: undefined, samples: 0},
  };
  let reportTimer;

  try {
    const ready = await waitForReady(proxy);
    const proxyUrl = `http://127.0.0.1:${ready.port}`;
    const startedAt = Date.now();
    const deadline = startedAt + options.durationMs;
    observeRss(stats.rss, await processRssKiB(proxy.pid));
    report({event: "soak-started", pid: proxy.pid, dataDir, proxyUrl, options});
    reportTimer = setInterval(() => {
      void reportProgress(proxy.pid, startedAt, stats);
    }, options.reportIntervalMs);
    reportTimer.unref();

    const workers = Array.from({length: options.concurrency}, () => runWorker({
      proxyUrl,
      deadline,
      options,
      stats,
      interrupted: () => interrupted,
    }));
    await Promise.all(workers);
    if (reportTimer) clearInterval(reportTimer);
    observeRss(stats.rss, await processRssKiB(proxy.pid));
    await stopChild(proxy);
    const raw = await inspectRaw(dataDir);
    const stopped = proxyEvents.findLast(event => event.event === "proxy-stopped");
    const capture = stopped?.capture;
    const summary = {
      event: "soak-complete",
      elapsedMs: Date.now() - startedAt,
      requests: requestSummary(stats),
      raw,
      capture,
      rss: stats.rss,
      requestLimitMet: !Number.isFinite(options.requestLimit)
        || stats.completed + stats.failed >= options.requestLimit,
      interrupted,
      dataDir: options.keepData ? dataDir : undefined,
    };
    report(summary);
    if (stats.failed > 0 || raw.invalidLines > 0 || raw.invalidBodies > 0
      || raw.missingBodies > 0 || raw.temporaryFiles > 0
      || raw.exchangeCount !== stats.completed || !summary.requestLimitMet
      || !isCleanCaptureState(capture)) {
      throw new Error("soak 验收失败，详见 soak-complete 摘要");
    }
    return summary;
  } finally {
    if (reportTimer) clearInterval(reportTimer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (proxy.exitCode === null && proxy.signalCode === null) await stopChild(proxy).catch(() => undefined);
    upstream.close();
    if (upstream.listening) await once(upstream, "close");
    if (!options.keepData) await rm(runtimeRoot, {recursive: true, force: true});
  }
}

async function runWorker(input) {
  while (!input.interrupted() && Date.now() < input.deadline) {
    if (input.stats.started >= input.options.requestLimit) return;
    const id = input.stats.started++;
    const request = createSoakRequest(id, input.options);
    const startedAt = performance.now();
    try {
      const response = await fetch(`${input.proxyUrl}${request.path}`, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
      });
      input.stats.firstByte.observe(performance.now() - startedAt);
      const body = await response.text();
      if (!response.ok || (request.streaming && !body.includes("response.completed"))) {
        throw new Error(`unexpected soak response ${response.status}`);
      }
      if (request.large && body.length < input.options.largeBodyBytes) {
        throw new Error(`large soak response was shorter than ${input.options.largeBodyBytes} bytes`);
      }
      input.stats.total.observe(performance.now() - startedAt);
      input.stats.completed += 1;
      if (request.streaming) input.stats.sseCompleted += 1;
    } catch {
      input.stats.failed += 1;
    }
  }
}

function createFixtureServer(options) {
  const largeBody = JSON.stringify({ok: true, payload: "y".repeat(options.largeBodyBytes)});
  return createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      if (request.url !== "/v1/responses") {
        response.writeHead(404, {"content-type": "application/json"});
        response.end(JSON.stringify({error: "unexpected fixture path"}));
        return;
      }
      if (request.headers.accept === "text/event-stream") {
        response.writeHead(200, {"content-type": "text/event-stream"});
        response.write("event: response.created\ndata: {\"type\":\"response.created\"}\n\n");
        setTimeout(() => {
          response.end("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n");
        }, options.sseDelayMs);
        return;
      }
      if (request.headers["x-deepaa-soak-large"] === "1") {
        response.writeHead(200, {"content-type": "application/json", "content-length": String(largeBody.length)});
        response.end(largeBody);
        return;
      }
      const body = JSON.stringify({ok: true});
      response.writeHead(200, {"content-type": "application/json", "content-length": String(body.length)});
      response.end(body);
    });
  });
}

function observeProxyEvents(child) {
  const events = [];
  let stdout = "";
  child.stdout.on("data", chunk => {
    stdout += chunk.toString();
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const value = JSON.parse(line);
        if (value && typeof value === "object") events.push(value);
      } catch {
        // 只记录代理 JSON 协议事件。
      }
    }
  });
  return events;
}

function isCleanCaptureState(value) {
  return value
    && value.capturePendingBytes === 0
    && value.activeFinalizers === 0
    && value.queuedFinalizers === 0
    && value.capturePendingTasks === 0
    && value.capturePendingRecordBytes === 0
    && value.captureDroppedRecords === 0
    && value.captureMissingBodies === 0;
}

async function reportProgress(pid, startedAt, stats) {
  const rssKiB = await processRssKiB(pid);
  observeRss(stats.rss, rssKiB);
  report({
    event: "soak-progress",
    elapsedMs: Date.now() - startedAt,
    rssKiB,
    requests: requestSummary(stats),
  });
}

function observeRss(summary, value) {
  if (value === undefined) return;
  summary.firstKiB ??= value;
  summary.lastKiB = value;
  summary.peakKiB = Math.max(summary.peakKiB ?? 0, value);
  summary.samples += 1;
}

function requestSummary(stats) {
  return {
    started: stats.started,
    completed: stats.completed,
    failed: stats.failed,
    sseCompleted: stats.sseCompleted,
    firstByteMs: stats.firstByte.summary(),
    totalMs: stats.total.summary(),
  };
}

export async function inspectRaw(dataDir) {
  const captureDir = join(dataDir, "captures", "v2");
  const files = await readdir(captureDir);
  let exchangeCount = 0;
  let invalidLines = 0;
  let invalidBodies = 0;
  let missingBodies = 0;
  let bytes = 0;
  const externalBodyChecks = new Map();
  for (const file of files) {
    const path = join(captureDir, file);
    bytes += (await stat(path)).size;
    const lines = createInterface({input: createReadStream(path), crlfDelay: Infinity});
    for await (const line of lines) {
      if (!line) continue;
      try {
        const value = JSON.parse(line);
        if (value.schemaVersion !== 2 || !value.request || !value.response) {
          invalidLines += 1;
          continue;
        }
        exchangeCount += 1;
        for (const body of [value.request, value.response]) {
          const status = await verifyCapturedBody(dataDir, body, externalBodyChecks);
          if (status === "invalid") invalidBodies += 1;
          if (status === "missing") missingBodies += 1;
        }
      } catch {
        invalidLines += 1;
      }
    }
  }
  const temporaryDirectory = join(dataDir, "blobs", ".tmp");
  const temporaryFiles = await readdir(temporaryDirectory).then(entries => entries.length, () => 0);
  return {
    captureFiles: files.length,
    exchangeCount,
    invalidLines,
    invalidBodies,
    missingBodies,
    bytes,
    temporaryFiles,
  };
}

async function verifyCapturedBody(dataDir, body, externalBodyChecks) {
  if (!body || typeof body !== "object") return "invalid";
  const expectedSize = body.bodySizeBytes;
  const expectedSha = body.bodySha256;
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0
    || typeof expectedSha !== "string" || !/^[0-9a-f]{64}$/u.test(expectedSha)) {
    return "invalid";
  }
  const reference = body.rawBodyRef;
  if (typeof body.rawBody === "string") {
    return verifyLogicalBytes(Buffer.from(body.rawBody, "utf8"), expectedSize, expectedSha, reference)
      ? "valid" : "invalid";
  }
  if (!reference || typeof reference !== "object") return "missing";
  if (reference.storage === "compressed-inline" && typeof reference.inlineBase64 === "string") {
    try {
      const compressed = Buffer.from(reference.inlineBase64, "base64");
      if (!validCompressedSize(compressed, reference)) return "invalid";
      const logical = reference.encoding === "gzip" ? gunzipSync(compressed) : compressed;
      return verifyLogicalBytes(logical, expectedSize, expectedSha, reference) ? "valid" : "invalid";
    } catch {
      return "invalid";
    }
  }
  if (reference.storage !== "external-blob" || typeof reference.externalPath !== "string") {
    return "invalid";
  }
  const cacheKey = `${reference.externalPath}\0${expectedSize}\0${expectedSha}\0${reference.compressedSizeBytes}`;
  if (externalBodyChecks.has(cacheKey)) return externalBodyChecks.get(cacheKey) ? "valid" : "invalid";
  let valid = false;
  try {
    const root = resolve(dataDir);
    const path = resolve(root, reference.externalPath);
    const childPath = relative(root, path);
    if (!childPath || childPath.startsWith("..") || isAbsolute(childPath)) throw new Error("blob path escapes dataDir");
    const compressed = await readFile(path);
    if (!validCompressedSize(compressed, reference)) throw new Error("blob compressed size mismatch");
    const logical = reference.encoding === "gzip" ? gunzipSync(compressed) : compressed;
    valid = verifyLogicalBytes(logical, expectedSize, expectedSha, reference);
  } catch {
    valid = false;
  }
  externalBodyChecks.set(cacheKey, valid);
  return valid ? "valid" : "invalid";
}

function validCompressedSize(buffer, reference) {
  return reference.compressedSizeBytes === undefined
    || reference.compressedSizeBytes === buffer.length;
}

function verifyLogicalBytes(buffer, expectedSize, expectedSha, reference) {
  if (buffer.length !== expectedSize) return false;
  if (reference && (reference.sizeBytes !== expectedSize || reference.sha256 !== expectedSha)) return false;
  return createHash("sha256").update(buffer).digest("hex") === expectedSha;
}

async function waitForReady(child) {
  return await new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`soak proxy ready 超时: ${stderr}`)), 10_000);
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
      for (const line of stdout.split("\n")) {
        try {
          const value = JSON.parse(line);
          if (value.event === "proxy-ready") {
            clearTimeout(timer);
            resolvePromise(value);
            return;
          }
        } catch {
          // 只消费 ready JSON 行。
        }
      }
    });
    child.once("exit", code => {
      clearTimeout(timer);
      reject(new Error(`soak proxy 在 ready 前退出 (${code}): ${stderr}`));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("soak proxy 未在 20 秒内退出")), 20_000)),
  ]).catch(error => {
    child.kill("SIGKILL");
    throw error;
  });
}

async function processRssKiB(pid) {
  if (!pid || process.platform === "win32") return undefined;
  return await new Promise(resolvePromise => {
    const child = spawn("ps", ["-o", "rss=", "-p", String(pid)], {stdio: ["ignore", "pipe", "ignore"]});
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.once("exit", code => {
      const value = Number.parseInt(output.trim(), 10);
      resolvePromise(code === 0 && Number.isFinite(value) ? value : undefined);
    });
    child.once("error", () => resolvePromise(undefined));
  });
}

class LatencyHistogram {
  #bounds = [1, 2, 5, 10, 20, 50, 100, 250, 500, 1_000, 5_000, Number.POSITIVE_INFINITY];
  #counts = this.#bounds.map(() => 0);
  #count = 0;
  #sum = 0;
  #max = 0;

  observe(value) {
    this.#count += 1;
    this.#sum += value;
    this.#max = Math.max(this.#max, value);
    const index = this.#bounds.findIndex(bound => value <= bound);
    this.#counts[index] += 1;
  }

  summary() {
    return {
      count: this.#count,
      average: this.#count ? round(this.#sum / this.#count) : 0,
      p95: this.#percentile(0.95),
      p99: this.#percentile(0.99),
      max: round(this.#max),
    };
  }

  #percentile(ratio) {
    if (this.#count === 0) return 0;
    const target = Math.ceil(this.#count * ratio);
    let seen = 0;
    for (let index = 0; index < this.#counts.length; index += 1) {
      seen += this.#counts[index];
      if (seen >= target) {
        const bound = this.#bounds[index];
        return Number.isFinite(bound) ? bound : round(this.#max);
      }
    }
    return round(this.#max);
  }
}

function positiveInteger(value, name) {
  return boundedInteger(value, name, 1, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 的整数`);
  }
  return parsed;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function report(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function isMainModule(argvPath, moduleUrl) {
  if (!argvPath || !existsSync(argvPath)) return false;
  return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
}

if (isMainModule(process.argv[1], import.meta.url)) {
  runProxySoak().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
