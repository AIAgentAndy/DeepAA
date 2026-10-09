/**
 * 价格中心版本时间展示口径（2026-09-07 用户确认，固定东八区·上海）：
 * - 纯日期（YYYY-MM-DD，历史存量 publishedAt）原样展示，不做时区换算假精度。
 * - 无时区后缀的墙钟写法（目录发布格式「YYYY-MM-DD HH:mm:ss」/ 历史 T 分隔存储）：
 *   视为东八区墙钟，统一为空格分隔原样展示，不二次偏移。
 * - 带时区标记的时间（如 LiteLLM 导入的 UTC ISO）→ 固定换算为东八区「YYYY-MM-DD HH:mm:ss」。
 * - 其余无法解析的值原样返回，由调用方决定占位文案。
 */
export function formatVersionDateTime(value: string | undefined): string {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  // 仅匹配完整墙钟（结尾锚定，不带毫秒/时区后缀）；带 Z 的 UTC ISO 走下方换算分支。
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/u.test(value)) {
    return value.replace("T", " ").slice(0, 19);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const shifted = new Date(parsed.getTime() + 8 * 60 * 60_000);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
    + ` ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}
