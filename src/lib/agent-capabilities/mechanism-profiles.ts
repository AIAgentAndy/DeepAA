/**
 * P1-7（2026-11-03）：机制剖面加载（config/agents/harness/mechanism-profiles.json）。
 * 版本化冻结基线（schemaVersion/updatedAt），人工修订；不在运行时分析源码。
 * 读取失败返回 undefined（页面诚实降级为「剖面暂不可用」，不阻断台账视图）。
 */

import {readFile} from "node:fs/promises";
import {join} from "node:path";

export interface MechanismTopic {
  key: string;
  label: string;
}

export interface MechanismEntry {
  topic: string;
  title: string;
  detail: string;
  source: string;
}

export interface AgentMechanismProfile {
  summary: string;
  mechanisms: MechanismEntry[];
}

export interface MechanismProfiles {
  schemaVersion: number;
  updatedAt: string;
  topics: MechanismTopic[];
  agents: Record<string, AgentMechanismProfile>;
}

let cache: {profiles: MechanismProfiles; loadedAt: number} | undefined;
const CACHE_TTL_MS = 60_000;

export async function loadMechanismProfiles(projectRoot?: string): Promise<MechanismProfiles | undefined> {
  if (cache && cache.loadedAt + CACHE_TTL_MS > Date.now()) return cache.profiles;
  try {
    const root = projectRoot || process.cwd();
    const raw = await readFile(join(root, "config", "agents", "harness", "mechanism-profiles.json"), "utf8");
    const parsed = JSON.parse(raw) as MechanismProfiles;
    if (typeof parsed.schemaVersion !== "number" || !parsed.topics || !parsed.agents) return undefined;
    cache = {profiles: parsed, loadedAt: Date.now()};
    return parsed;
  } catch {
    return undefined;
  }
}
