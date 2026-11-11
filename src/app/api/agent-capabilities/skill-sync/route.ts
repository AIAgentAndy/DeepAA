import {jsonResponse} from "@/lib/app-state";
import {cpSync, existsSync, mkdirSync, readFileSync, statSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {skillSyncTargetDir} from "@/lib/agent-capabilities/scanner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_SYNC_BYTES = 5 * 1024 * 1024;

function md5Of(path: string): string {
  try { return createHash("md5").update(readFileSync(path)).digest("hex"); }
  catch { return "unknown"; }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json() as {
      skillName?: string; sourceAgent?: string; targetAgent?: string;
      sourcePath?: string; confirm?: boolean;
    };
    const {skillName, sourceAgent, targetAgent, sourcePath, confirm} = body;
    if (!skillName || !sourceAgent || !targetAgent || !sourcePath) {
      return Response.json({error: "MISSING_PARAMS"}, {status: 400});
    }
    const home = homedir();
    const targetDir = skillSyncTargetDir(home, targetAgent);
    if (!targetDir) return Response.json({error: "TARGET_NOT_SUPPORTED", message: `${targetAgent} 不支持 skill 同步`}, {status: 400});
    const targetPath = join(targetDir, skillName);

    // 安全检查:源必须存在且是目录。
    if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
      return Response.json({error: "SOURCE_NOT_FOUND", message: `源 skill 目录不存在: ${sourcePath}`}, {status: 404});
    }
    // 大小预算。
    const sourceSize = statSync(sourcePath).size;
    if (sourceSize > MAX_SYNC_BYTES) {
      return Response.json({error: "SOURCE_TOO_LARGE", message: `skill 目录 ${(sourceSize / 1024 / 1024).toFixed(1)}MiB 超过 5MiB 上限`}, {status: 400});
    }
    // 目标已存在且内容不同 → 需要 confirm。
    const targetSkillMd = join(targetPath, "SKILL.md");
    if (existsSync(targetPath)) {
      const sourceMd5 = md5Of(join(sourcePath, "SKILL.md"));
      const targetMd5 = md5Of(targetSkillMd);
      if (sourceMd5 !== targetMd5 && !confirm) {
        return Response.json({
          error: "CONFIRM_REQUIRED",
          message: `目标已存在且内容不同(source=${sourceMd5.slice(0,8)} target=${targetMd5.slice(0,8)})。传 confirm: true 覆盖。`,
          sourceHash: sourceMd5,
          targetHash: targetMd5,
        }, {status: 409});
      }
    }

    // 执行复制。
    mkdirSync(targetDir, {recursive: true});
    cpSync(sourcePath, targetPath, {recursive: true});
    return jsonResponse({
      ok: true,
      skillName,
      sourceAgent,
      targetAgent,
      sourcePath,
      targetPath,
      message: `已将 ${skillName} 从 ${sourceAgent} 同步到 ${targetAgent}`,
    });
  } catch (error) {
    return Response.json({error: "SYNC_FAILED", message: (error as Error).message}, {status: 500});
  }
}
