import {createHash, createHmac, randomUUID} from "node:crypto";

/**
 * 阿里云 POP V3（ACS3-HMAC-SHA256）签名（官方 V3 请求结构与签名文档）：
 * CanonicalRequest = METHOD \n URI \n Query \n CanonicalHeaders \n SignedHeaders \n HexSHA256(body)；
 * StringToSign = "ACS3-HMAC-SHA256" \n HexSHA256(CanonicalRequest)；
 * Signature = HexHMAC-SHA256(AccessKeySecret, StringToSign)——密钥即 AccessKeySecret，
 * 无 AWS SigV4 式派生链。GET 空 body 的 payload 哈希固定为空串 SHA256。
 */
export const ALIBABA_MODELSTUDIO_HOST = "modelstudio.cn-beijing.aliyuncs.com";
export const ALIBABA_MODELSTUDIO_API_VERSION = "2026-02-10";
export const EMPTY_BODY_SHA256 = createHash("sha256").update("").digest("hex");

export interface Acs3SignatureInput {
  accessKeyId: string;
  accessKeySecret: string;
  method: "GET" | "POST";
  /** ROA 路径（如 /tokenplan/subscription/stats），不含 host 与 query。 */
  canonicalUri: string;
  /** 已按名称升序、RFC3986 编码的查询串（无参数传空字符串）。 */
  canonicalQuery: string;
  action: string;
  apiVersion?: string;
  body?: string;
  now?: Date;
}

export interface Acs3Signature {
  authorization: string;
  xAcsDate: string;
  nonce: string;
  contentSha256: string;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function rfc3339Utc(date: Date): string {
  return `${date.toISOString().replace(/\.\d{3}Z$/u, "Z")}`;
}

export function createAcs3Signature(input: Acs3SignatureInput): Acs3Signature {
  const body = input.body ?? "";
  const contentSha256 = body === "" ? EMPTY_BODY_SHA256 : sha256Hex(body);
  const xAcsDate = rfc3339Utc(input.now ?? new Date());
  const nonce = randomUUID();
  const version = input.apiVersion ?? ALIBABA_MODELSTUDIO_API_VERSION;
  const headers: Array<[string, string]> = ([
    ["host", ALIBABA_MODELSTUDIO_HOST],
    ["x-acs-action", input.action],
    ["x-acs-content-sha256", contentSha256],
    ["x-acs-date", xAcsDate],
    ["x-acs-signature-nonce", nonce],
    ["x-acs-version", version],
  ] as Array<[string, string]>).sort(([left], [right]) => left.localeCompare(right));
  const signedHeaders = headers.map(([name]) => name).join(";");
  const canonicalHeaders = headers.map(([name, value]) => `${name}:${value.trim()}\n`).join("");
  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    input.canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    contentSha256,
  ].join("\n");
  const stringToSign = `ACS3-HMAC-SHA256\n${sha256Hex(canonicalRequest)}`;
  const signature = createHmac("sha256", input.accessKeySecret).update(stringToSign).digest("hex");
  return {
    authorization: `ACS3-HMAC-SHA256 Credential=${input.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`,
    xAcsDate,
    nonce,
    contentSha256,
    canonicalRequest,
    stringToSign,
    signature,
  };
}
