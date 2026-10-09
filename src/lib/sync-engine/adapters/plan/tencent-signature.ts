import {createHash, createHmac} from "node:crypto";

/** TokenHub 管控面 OpenAPI（DescribeTokenPlan 等，cloud.tencent.com/document/product/1823/132289）。 */
export const TENCENT_TOKENHUB_HOST = "tokenhub.tencentcloudapi.com";
export const TENCENT_TOKENHUB_SERVICE = "tokenhub";
export const TENCENT_TOKENHUB_API_VERSION = "2026-03-22";
/** TokenHub 套餐归属广州地域；DescribeTokenPlan 族对地域不敏感但签名与头部要求一致。 */
export const TENCENT_TOKENHUB_REGION = "ap-guangzhou";
export const TENCENT_CONTENT_TYPE = "application/json; charset=utf-8";
export const TENCENT_SIGNED_HEADERS = "content-type;host;x-tc-action";

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Uint8Array | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

export interface TencentCloudSignatureInput {
  secretId: string;
  secretKey: string;
  action: string;
  /** 请求体 JSON 字符串；同一串必须同时用于签名与实际发送。 */
  payload: string;
  now?: Date;
}

export interface TencentCloudSignature {
  authorization: string;
  xTcAction: string;
  xTcTimestamp: string;
  canonicalRequest: string;
  credentialScope: string;
  stringToSign: string;
}

/**
 * 腾讯云 API 3.0 TC3-HMAC-SHA256 签名：CanonicalRequest 固定 POST / 空查询串，
 * 签名头固定 content-type/host/x-tc-action（action 小写），密钥派生链为
 * "TC3"+SecretKey → date → service → "tc3_request"，与火山 HMAC 不能混用。
 */
export function createTencentCloudSignature(input: TencentCloudSignatureInput): TencentCloudSignature {
  const now = input.now ?? new Date();
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const date = new Date(now.getTime()).toISOString().slice(0, 10);
  const xTcAction = input.action.toLowerCase();
  const hashedPayload = sha256Hex(input.payload);
  const canonicalRequest = [
    "POST",
    "/",
    "",
    [
      `content-type:${TENCENT_CONTENT_TYPE}`,
      `host:${TENCENT_TOKENHUB_HOST}`,
      `x-tc-action:${xTcAction}`,
    ].join("\n"),
    "",
    TENCENT_SIGNED_HEADERS,
    hashedPayload,
  ].join("\n");
  const credentialScope = `${date}/${TENCENT_TOKENHUB_SERVICE}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    timestamp,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const kDate = hmac(`TC3${input.secretKey}`, date);
  const kService = hmac(kDate, TENCENT_TOKENHUB_SERVICE);
  const kSigning = hmac(kService, "tc3_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");
  return {
    authorization: "TC3-HMAC-SHA256 Credential="
      + `${input.secretId}/${credentialScope}, `
      + `SignedHeaders=${TENCENT_SIGNED_HEADERS}, Signature=${signature}`,
    xTcAction,
    xTcTimestamp: timestamp,
    canonicalRequest,
    credentialScope,
    stringToSign,
  };
}
