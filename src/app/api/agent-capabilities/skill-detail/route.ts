import {getDeepaaDatabase} from "@/lib/db/connection";
import {jsonResponse} from "@/lib/app-state";
import {readFileSync, statSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {resolveDeepaaDataDir} from "@/lib/data-paths";
import {scanLocalCapabilities} from "@/lib/agent-capabilities/scanner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_SKILL_MD_BYTES = 100 * 1024;

export async function GET(request: Request): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams;
    const name = params.get("name")?.trim() || "";
    if (!name) return Response.json({error: "MISSING_PARAMS"}, {status: 400});
    const home = homedir();
    const ledgers = scanLocalCapabilities({homeDir: home, dataDir: resolveDeepaaDataDir()});
    const idx = (ledgers as {crossAgentIndex?: {skills: Array<{name: string; agents: Array<{agentId: string; path: string; contentHash: string; consistent: boolean}>; allConsistent: boolean}>}}).crossAgentIndex;
    const entry = idx?.skills.find(s => s.name === name);
    if (!entry) return Response.json({error: "NOT_FOUND", message: `Skill ${name} 未找到`}, {status: 404});
    // 读全文(取第一个有路径的 agent)
    let content: string | undefined;
    for (const a of entry.agents) {
      if (a.path) {
        try {
          // path 是 skill 目录,正文读其中的 SKILL.md(≤100KiB)。
          const skillMd = join(a.path, "SKILL.md");
          const stat = statSync(skillMd);
          if (stat.isFile() && stat.size <= MAX_SKILL_MD_BYTES) {
            content = readFileSync(skillMd, "utf8");
            break;
          }
        } catch { /* try next */ }
      }
    }
    return jsonResponse({...entry, ...(content ? {content} : {})});
  } catch (error) {
    return Response.json({error: "DETAIL_FAILED", message: (error as Error).message}, {status: 500});
  }
}
