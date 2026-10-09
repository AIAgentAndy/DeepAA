/**
 * 指纹文本哈希的空白折叠（2026-09-17）：客户端会在字符串 content 与数组 part
 * 等 wire 形态间重排同一文本，空白序列也可能被重新序列化（实测 zcode 标题调用
 * 与主请求对同一 prompt 的 1/2 空格差异）。折叠后同一逻辑内容得到同一
 * textSha256，排重基线不再被形态漂移打断。
 *
 * 投影（ContentPreviewItemWriter）与交互内容页流式渲染（iterateConversationBodyEvents）
 * 必须共用本实现——两条路径各算一份会出现哈希口径分叉，页面把 inherited 误标
 * 成「当前步骤新增」（2026-09-17 codex/opencode 实测）。
 * 跨 chunk 边界经 StringDecoder 安全解码，多字节字符不受切割影响。
 */
import { createHash, type Hash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export class WhitespaceCollapsedHash {
  private readonly hash: Hash = createHash("sha256");
  private readonly decoder = new StringDecoder("utf8");
  private pendingWhitespace = false;

  update(value: string | Buffer): void {
    const text = typeof value === "string" ? value : this.decoder.write(value);
    this.consumeText(text);
  }

  digest(): string {
    this.consumeText(this.decoder.end());
    this.flushPendingWhitespace();
    return this.hash.digest("hex");
  }

  private consumeText(text: string): void {
    if (!text) return;
    for (const part of text.split(/(\s+)/u)) {
      if (!part) continue;
      if (/^\s+$/u.test(part)) {
        this.pendingWhitespace = true;
        continue;
      }
      this.flushPendingWhitespace();
      this.hash.update(Buffer.from(part, "utf8"));
    }
  }

  private flushPendingWhitespace(): void {
    if (!this.pendingWhitespace) return;
    this.hash.update(Buffer.from(" ", "utf8"));
    this.pendingWhitespace = false;
  }
}
