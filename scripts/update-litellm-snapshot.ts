import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeLiteLLMPricingCatalog } from "../src/lib/pricing.js";

const SOURCE_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OUTPUT_PATH = join(process.cwd(), "data", "defaults", "litellm-model-prices.snapshot.json");
const MAX_BYTES = 8 * 1024 * 1024;

const inputPath = process.argv.slice(2).find(argument => argument !== "--")?.trim();
const text = inputPath ? await readFile(inputPath, "utf-8") : await downloadCatalog();
if (Buffer.byteLength(text, "utf-8") > MAX_BYTES) {
  throw new Error("LiteLLM 价格表超过 8 MiB 安全大小限制。");
}

const catalog = JSON.parse(text) as unknown;
const fetchedAt = new Date().toISOString();
const snapshot = normalizeLiteLLMPricingCatalog(catalog, {
  sourceUrl: SOURCE_URL,
  fetchedAt,
  sourceHash: `sha256:${createHash("sha256").update(text).digest("hex")}`,
});
// 快照只发布 LiteLLM 目录，不能夹带本机代理策略或用户手动覆盖。
snapshot.targetOverrides = [];
snapshot.targetVendorPreferences = undefined;
snapshot.models = snapshot.models.filter(model => model.confidence !== "user_override");
if (snapshot.catalogSource) snapshot.catalogSource.modelCount = snapshot.models.length;

await mkdir(join(process.cwd(), "data", "defaults"), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
console.log(`LiteLLM snapshot updated models=${snapshot.models.length} hash=${snapshot.catalogSource?.hash} path=${OUTPUT_PATH}`);

async function downloadCatalog(): Promise<string> {
  const response = await fetch(SOURCE_URL, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`LiteLLM 价格表下载失败：HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") || "");
  if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
    throw new Error("LiteLLM 价格表超过 8 MiB 安全大小限制。");
  }
  return response.text();
}
