import assert from "node:assert/strict";
import {describe, test} from "vitest";
import {loadMechanismProfiles} from "../src/lib/agent-capabilities/mechanism-profiles.js";

/**
 * P1-7（2026-11-03）：机制剖面结构守卫——五 Agent 覆盖、八主题 key 合法、
 * 每条带来源标注（剖面是人工冻结基线，不是运行时分析产物）。
 */
describe("P1-7 机制剖面", () => {
  test("五 Agent 覆盖,八主题 key 合法,每条带 title/detail/source", async () => {
    const profiles = await loadMechanismProfiles();
    assert.ok(profiles, "剖面文件必须可加载");
    assert.equal(profiles.schemaVersion, 1);

    const agentIds = Object.keys(profiles.agents);
    for (const expected of ["codex", "claude", "zcode", "dsh", "opencode"]) {
      assert.ok(agentIds.includes(expected), `缺少 ${expected} 剖面`);
    }
    const topicKeys = new Set(profiles.topics.map(topic => topic.key));
    assert.equal(topicKeys.size, 8, "八主题框架");
    for (const expected of ["startup", "instructions", "capability-discovery", "tool-execution", "security", "control-flow", "subagents", "persistence"]) {
      assert.ok(topicKeys.has(expected), `缺少主题 ${expected}`);
    }
    let entryCount = 0;
    for (const [agentId, profile] of Object.entries(profiles.agents)) {
      assert.ok(profile.summary.length > 0, `${agentId} 缺摘要`);
      assert.ok(profile.mechanisms.length >= 4, `${agentId} 剖面条目过少`);
      for (const entry of profile.mechanisms) {
        entryCount += 1;
        assert.ok(topicKeys.has(entry.topic), `${agentId} 条目使用了未定义主题 ${entry.topic}`);
        assert.ok(entry.title.length > 0, `${agentId} 条目缺标题`);
        assert.ok(entry.detail.length > 10, `${agentId} 条目 ${entry.title} 说明过短`);
        assert.ok(entry.source.length > 3, `${agentId} 条目 ${entry.title} 缺来源标注`);
      }
    }
    assert.ok(entryCount >= 25, `剖面总条目过少: ${entryCount}`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/u.test(profiles.updatedAt), "updatedAt 必须是日期");
  });
});
