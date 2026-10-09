/**
 * 字符 → token 估算（一期决策 D2）：CJK≈1 token/码点，其余≈1/4 token/字符。
 * 仅用于上下文构成参考展示；不参与计价，绝不写入 usage_ledger。
 */

export function isCjkCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x3040 && codePoint <= 0x30ff) // 平假名/片假名
    || (codePoint >= 0x3400 && codePoint <= 0x4dbf) // CJK 扩展 A
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff) // CJK 统一表意
    || (codePoint >= 0xac00 && codePoint <= 0xd7af) // 谚文
    || (codePoint >= 0x3000 && codePoint <= 0x303f) // CJK 标点
    || (codePoint >= 0xff00 && codePoint <= 0xffef); // 全角形式
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let codePoints = 0;
  let cjk = 0;
  for (const character of text) {
    codePoints++;
    const codePoint = character.codePointAt(0) ?? 0;
    if (isCjkCodePoint(codePoint)) cjk++;
  }
  return cjk + Math.ceil((codePoints - cjk) / 4);
}
