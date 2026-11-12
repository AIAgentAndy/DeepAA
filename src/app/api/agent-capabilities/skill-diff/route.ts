import {jsonResponse} from "@/lib/app-state";
import {readFileSync, statSync} from "node:fs";
import {homedir} from "node:os";
import {resolveDeepaaDataDir} from "@/lib/data-paths";
import {join} from "node:path";
import {scanLocalCapabilities} from "@/lib/agent-capabilities/scanner";
import {
  assertLocalReadRequest,
  DevelopmentLaunchError,
  developmentLaunchErrorResponse,
} from "@/lib/development-launch/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 100 * 1024;

/** 简单行级 diff:返回结构化 hunks(增加/删除/上下文)。 */
function lineDiff(a: string[], b: string[]): Array<{type: "ctx" | "add" | "del"; aLine?: number; bLine?: number; text: string}> {
  const result: Array<{type: "ctx" | "add" | "del"; aLine?: number; bLine?: number; text: string}> = [];
  // 简化 LCS:只做顺序匹配(对 SKILL.md 够用,全文 markdown 不需要精确 Myers)
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      result.push({type: "ctx", aLine: i + 1, bLine: j + 1, text: a[i]!});
      i++; j++;
    } else if (j < b.length && (i >= a.length || !a.slice(i, i + 3).includes(b[j]!))) {
      result.push({type: "add", bLine: j + 1, text: b[j]!});
      j++;
    } else if (i < a.length) {
      result.push({type: "del", aLine: i + 1, text: a[i]!});
      i++;
    } else {
      result.push({type: "add", bLine: j + 1, text: b[j]!});
      j++;
    }
  }
  return result;
}

export async function GET(request: Request): Promise<Response> {
  try {
    assertLocalReadRequest(request);
    const params = new URL(request.url).searchParams;
    const name = params.get("name")?.trim() || "";
    const agentA = params.get("agentA")?.trim() || "";
    const agentB = params.get("agentB")?.trim() || "";
    if (!name || !agentA || !agentB) return Response.json({error: "MISSING_PARAMS"}, {status: 400});
    const home = homedir();
    const ledgers = scanLocalCapabilities({homeDir: home, dataDir: resolveDeepaaDataDir()});
    const idx = (ledgers as {crossAgentIndex?: {skills: Array<{name: string; agents: Array<{agentId: string; path: string; contentHash: string}>}>}}).crossAgentIndex;
    const entry = idx?.skills.find(s => s.name === name);
    if (!entry) return Response.json({error: "NOT_FOUND"}, {status: 404});
    const pathA = entry.agents.find(a => a.agentId === agentA)?.path;
    const pathB = entry.agents.find(a => a.agentId === agentB)?.path;
    if (!pathA || !pathB) return Response.json({error: "AGENT_NOT_FOUND", message: `${agentA} 或 ${agentB} 无此 skill`}, {status: 404});
    const readSafe = (dir: string): string => {
      // path 是 skill 目录,正文读其中的 SKILL.md(≤100KiB)。
      const skillMd = join(dir, "SKILL.md");
      const stat = statSync(skillMd);
      if (!stat.isFile() || stat.size > MAX_BYTES) return "(文件不可读或超限)";
      return readFileSync(skillMd, "utf8");
    };
    const textA = readSafe(pathA);
    const textB = readSafe(pathB);
    const hunks = lineDiff(textA.split("\n"), textB.split("\n"));
    return jsonResponse({name, agentA, agentB, pathA, pathB, hunks});
  } catch (error) {
    if (error instanceof DevelopmentLaunchError) return developmentLaunchErrorResponse(error);
    return Response.json({error: "DIFF_FAILED", message: (error as Error).message}, {status: 500});
  }
}
