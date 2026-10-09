import {createHash, createHmac} from "node:crypto";

// 2026-09-30 官方文档核对（Base URL 及鉴权 1298459 / GetAFPUsage 2479847）：方舟 OpenAPI
// 管控面 host 为 ark 专用域，非火山通用网关 open.volcengineapi.com；签名 host 头与本
// 常量保持同一来源，换域必须同步签名（VOLCENGINE_SERVICE=ark 与该域对应）。
export const VOLCENGINE_OPENAPI_HOST = "ark.cn-beijing.volcengineapi.com";
export const VOLCENGINE_API_VERSION = "2024-01-01";
export const VOLCENGINE_SERVICE = "ark";
export const VOLCENGINE_CONTENT_TYPE = "application/json; charset=utf-8";
export const VOLCENGINE_SIGNED_HEADERS = "host;x-date;x-content-sha256;content-type";

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Uint8Array | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, char => {
    return `%${char.codePointAt(0)!.toString(16).toUpperCase()}`;
  });
}

/** 火山 OpenAPI 规范查询串；同一串必须同时用于 URL 和签名。 */
export function buildVolcengineCanonicalQuery(action: string, region: string): string {
  return [
    ["Action", action],
    ["Region", region],
    ["Version", VOLCENGINE_API_VERSION],
  ].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeQueryValue(key)}=${encodeQueryValue(value)}`)
    .join("&");
}

function formatXDate(date: Date): {xDate: string; shortDate: string} {
  const iso = date.toISOString();
  const shortDate = iso.slice(0, 10).replaceAll("-", "");
  return {xDate: `${shortDate}T${iso.slice(11, 19).replaceAll(":", "")}Z`, shortDate};
}

export interface VolcengineSignatureInput {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  canonicalQuery: string;
  body?: string;
  now?: Date;
}

export interface VolcengineSignature {
  authorization: string;
  xDate: string;
  xContentSha256: string;
  canonicalRequest: string;
  credentialScope: string;
  signature: string;
}

/**
 * 火山引擎 OpenAPI HMAC 签名：与 AWS SigV4 不能混用，差异在固定 header 顺序、
 * 算法标识、scope 终止串和 kDate 的密钥前缀。
 */
export function createVolcengineSignature(input: VolcengineSignatureInput): VolcengineSignature {
  const body = input.body ?? "";
  const {xDate, shortDate} = formatXDate(input.now ?? new Date());
  const xContentSha256 = sha256Hex(body);
  const canonicalHeaders = [
    `host:${VOLCENGINE_OPENAPI_HOST}`,
    `x-date:${xDate}`,
    `x-content-sha256:${xContentSha256}`,
    `content-type:${VOLCENGINE_CONTENT_TYPE}`,
  ].join("\n");
  const canonicalRequest = [
    "POST",
    "/",
    input.canonicalQuery,
    canonicalHeaders,
    "",
    VOLCENGINE_SIGNED_HEADERS,
    xContentSha256,
  ].join("\n");
  const credentialScope = `${shortDate}/${input.region}/${VOLCENGINE_SERVICE}/request`;
  const stringToSign = [
    "HMAC-SHA256",
    xDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const kDate = hmac(input.secretAccessKey, shortDate);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, VOLCENGINE_SERVICE);
  const kSigning = hmac(kService, "request");
  const signature = hmac(kSigning, stringToSign).toString("hex");
  return {
    authorization: "HMAC-SHA256 Credential="
      + `${input.accessKeyId}/${credentialScope}, `
      + `SignedHeaders=${VOLCENGINE_SIGNED_HEADERS}, Signature=${signature}`,
    xDate,
    xContentSha256,
    canonicalRequest,
    credentialScope,
    signature,
  };
}
