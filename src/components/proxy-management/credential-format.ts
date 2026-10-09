/** 密钥指纹显示：新格式已含前 4 + **** + 后 4；旧格式（hash 后 4 位）补 **** 前缀。 */
export function formatCredentialFingerprint(fingerprintSuffix: string | undefined): string {
  if (!fingerprintSuffix) return "****";
  return fingerprintSuffix.includes("****") ? fingerprintSuffix : `****${fingerprintSuffix}`;
}
