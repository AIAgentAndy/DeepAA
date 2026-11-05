/**
 * C-1 增量前文（2026-11-05）：读取上一轮已导入 exchange 的 request 正文。
 *
 * 动机（OOM 修复审计 R6）：超预算会话的 readExchangeDetail 冷路径每条详情都要
 * 从文件头全量重建 items（124MB 文件 ~1s/条、峰值 150-300MB）——C-1 改为
 * 「上一轮导入 wire 的 input 数组（本模块,有界直读 blob）+ rollout 尾部增量段
 * 解析」拼出全量等价 items,配合条数守卫（prefix+delta===itemCount）保证逐条
 * 与全量重建一致;失败/降级前文回退既有路径（B 门兜底）。
 *
 * 防御:行 ≤8MiB(导入 envelope 经 materializeLargeBodies 外置后恒小)、blob 解压
 * 后 ≤64MiB(超限视为不可用作前文)、**降级体检测**（含 [deepaa] 省略标记的
 * input 不可作完整前文——拼接会失真,必须回退）。blob 缺失/purged → undefined。
 */

import {openDeepaaDatabase} from "@/lib/db/connection";
import {readFileSync, openSync, readSync, closeSync} from "node:fs";
import {gunzipSync} from "node:zlib";
import {join} from "node:path";

const MAX_ENVELOPE_LINE_BYTES = 8 * 1024 * 1024;
const MAX_PREFIX_BODY_BYTES = 64 * 1024 * 1024;
export const PREFIX_OMISSION_MARKER = "[deepaa] 前文已省略";

export interface ImportedRequestBody {
  /** wire input 数组(原始 JSON 形态,与 itemWirePayload 产物逐字节同源)。 */
  input: Array<Record<string, unknown>>;
  instructions?: string;
}

/**
 * 按导入 exchangeId 读回上一轮合成 request 的 input 数组。
 * 返回 undefined = 不可用作前文（未导入/blob 缺失/超限/降级体）。
 */
export function readImportedRequestInput(
  dataDir: string,
  exchangeId: string,
): ImportedRequestBody | undefined {
  let db: ReturnType<typeof openDeepaaDatabase> | undefined;
  try {
    db = openDeepaaDatabase({dataDir, readonly: true});
  } catch {
    return undefined;
  }
  try {
    const row = db.prepare(
      `SELECT s.relative_path, r.byte_offset, r.line_length_bytes, r.raw_state
       FROM raw_exchange_refs r JOIN ingestion_sources s ON s.id = r.source_id
       WHERE r.exchange_id = ? AND r.origin = 'agent_local_import' LIMIT 1`,
    ).get(exchangeId) as {
      relative_path: string; byte_offset: number; line_length_bytes: number;
      raw_state: string;
    } | undefined;
    if (!row || row.raw_state !== "active") return undefined;
    if (row.line_length_bytes > MAX_ENVELOPE_LINE_BYTES) return undefined;

    const filePath = join(dataDir, row.relative_path);
    let line: Buffer;
    try {
      const fd = openReadFd(filePath);
      try {
        const buf = Buffer.alloc(row.line_length_bytes);
        const read = readFromFd(fd, buf, row.byte_offset);
        if (read !== row.line_length_bytes) return undefined;
        line = buf;
      } finally {
        closeFd(fd);
      }
    } catch {
      return undefined;
    }

    let envelope: {
      request?: {rawBody?: string; rawBodyRef?: {externalPath?: string; sha256?: string; sizeBytes?: number}; bodySizeBytes?: number; bodySha256?: string};
    };
    try {
      envelope = JSON.parse(line.toString("utf8")) as typeof envelope;
    } catch {
      return undefined;
    }
    const rawBody = envelope.request?.rawBody;
    if (typeof rawBody === "string") {
      return parseBody(rawBody);
    }
    const ref = envelope.request?.rawBodyRef;
    if (!ref?.externalPath || typeof ref.sha256 !== "string") return undefined;
    const declaredBytes = envelope.request?.bodySizeBytes;
    if (typeof declaredBytes !== "number" || declaredBytes > MAX_PREFIX_BODY_BYTES) {
      return undefined;
    }

    // 外置 blob:同步直读 + gunzipSync(解压后 ≤ 声明字节,上方已限 ≤64MiB;
    // C-1 第一版为有界直读,流式逐项提取留作后续优化)。
    const blobPath = join(dataDir, "blobs", ref.externalPath);
    const compressed = readFileSync(blobPath);
    let text: string;
    try {
      const decompressed = gunzipSync(compressed);
      if (decompressed.length > MAX_PREFIX_BODY_BYTES) return undefined;
      text = decompressed.toString("utf8");
    } catch {
      return undefined;
    }
    return parseBody(text);
  } catch {
    return undefined;
  } finally {
    try { db.close(); } catch { /* 短命只读连接。 */ }
  }
}

function parseBody(text: string): ImportedRequestBody | undefined {
  let body: {instructions?: string; input?: unknown};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return undefined;
  }
  if (!Array.isArray(body.input)) return undefined;
  const input: Array<Record<string, unknown>> = [];
  for (const item of body.input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    // 降级体检测:省略标记的 input 不是完整前文,拼接会失真——回退。
    const content = record.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const partText = part && typeof part === "object"
          ? (part as Record<string, unknown>).text
          : undefined;
        if (typeof partText === "string" && partText.includes(PREFIX_OMISSION_MARKER)) {
          return undefined;
        }
      }
    }
    input.push(record);
  }
  return {
    input,
    ...(typeof body.instructions === "string" ? {instructions: body.instructions} : {}),
  };
}

function openReadFd(path: string): number {
  return openSync(path, "r");
}
function readFromFd(fd: number, buf: Buffer, position: number): number {
  return readSync(fd, buf, 0, buf.length, position);
}
function closeFd(fd: number): void {
  try { closeSync(fd); } catch { /* 关闭失败忽略。 */ }
}
