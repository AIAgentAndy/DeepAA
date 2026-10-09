import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { AGENT_REGISTRY } from "../src/lib/agent-registry";

/**
 * Agent 扩展面守卫（ratchet，docs/上线前架构升级改造.md P1-8）：
 * 静态扫描 src/ 下对已知 agent 名的条件分派（=== / !== / case），与基线精确比对。
 * 基线只减不增：收敛一处就从基线删除；新增分派必须先给出注册表化方案并更新基线
 * （视为一次显式评审动作）。目标验收：新增 Agent 不再修改公共链路文件。
 */

const DISPATCH_PATTERN = new RegExp(
  "(===|!==|case)[ \\t]*\"(codex|claude|opencode|dsh|zcode)\"",
  "g",
);

/** 文档化基线：文件 → 条件分派出现次数（2026-09-14 策略化一期后快照，只减不增）。
 *
 * 启动链路通用文件已全部归零（service/resume-session/launch-plan/platform），
 * 新增 Agent 不得在这些文件出现分派（出现即失败，无基线可加）。
 * 基线内文件为各 Agent 专属功能面板/外观与语义层知识，按验收标准冻结不增长；
 * 纯新增 Agent 的语义知识请落在 strategies/、config-sync/adapters/ 或
 * conversation-semantics 的声明表中，而不是新增条件分派。 */
const BASELINE: Record<string, number> = {
  // 2026-10-05 +1：dsh「启动方式」下拉的 DeepSeek Harness 客户端专属 option
  // （value=dsh-app，与 codex-client option 同款既有模式；其余逻辑已通用化归零）。
  "src/components/development-launch-dialog.tsx": 35,
  "src/components/proxy-management/agent-default-entry-dialog.tsx": 5,
  "src/components/proxy-management/agent-entry-badges.tsx": 4,
  "src/components/proxy-management/proxy-agent-tab.tsx": 5,
  "src/components/proxy-management/proxy-resources-tab.tsx": 4,
  "src/lib/config-sync/file-display.ts": 5,
  "src/lib/conversation-semantics/classify.ts": 1,
  "src/lib/harness/agent.ts": 1,
  "src/lib/harness/skills-parser.ts": 2,
  "src/lib/ingestion/content-preview.ts": 1,
  "src/lib/ingestion/exchange-processor.ts": 5,
  "src/lib/ingestion/thread-identity.ts": 5,
  "src/proxy/upstream-transport.ts": 3,
  "src/reverse-proxy.ts": 2,
};

describe("Agent 扩展面守卫", () => {
  test("注册表每个 Agent 声明 semanticKind 与 logoExt", () => {
    for (const adapter of AGENT_REGISTRY) {
      expect(adapter.semanticKind, `${adapter.id} 缺少 semanticKind`).toBeTruthy();
      expect(
        ["png", "ico", "svg"].includes(adapter.logoExt),
        `${adapter.id} logoExt 非法`,
      ).toBe(true);
    }
  });

  test("agent 名条件分派不得超过基线（ratchet 只减不增）", () => {
    const files = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {encoding: "buffer"},
    )
      .toString("utf8")
      .split("\0")
      .filter(file => file.startsWith("src/") && /\.(ts|tsx)$/.test(file) && file !== "src/lib/agent-registry.ts");
    const actual = new Map<string, number>();
    let total = 0;
    for (const file of files) {
      // 工作区中已删除但尚未提交的跟踪文件（git ls-files --cached 仍列出）跳过。
      if (!existsSync(file)) continue;
      const content = readFileSync(file, "utf8");
      let count = 0;
      for (const match of content.matchAll(DISPATCH_PATTERN)) count += 1;
      if (count > 0) {
        actual.set(file, count);
        total += count;
      }
    }
    const violations: string[] = [];
    for (const [file, count] of actual) {
      const allowed = BASELINE[file];
      if (allowed === undefined) {
        violations.push(`新出现的 agent 名条件分派：${file}（x${count}）；请注册表化或在基线登记`);
      } else if (count > allowed) {
        violations.push(`${file} 分派数 ${count} 超过基线 ${allowed}；只减不增`);
      }
    }
    for (const file of Object.keys(BASELINE)) {
      if (!actual.has(file)) {
        violations.push(`基线中的 ${file} 已无分派，请从基线删除以保持精确`);
      }
    }
    expect(violations).toEqual([]);
    expect(total).toBeLessThanOrEqual(
      Object.values(BASELINE).reduce((sum, value) => sum + value, 0),
    );
  });
});
