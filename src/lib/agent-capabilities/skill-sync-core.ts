import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync} from "node:fs";
import {basename, join, resolve, sep} from "node:path";
import {createHash} from "node:crypto";
import {invalidateCapabilityScanCache, skillSyncTargetDir} from "./scanner";

/** 单个 skill 目录同步预算(递归内容大小)。 */
export const MAX_SYNC_BYTES = 5 * 1024 * 1024;

export interface SkillSyncParams {
  home: string;
  skillName: string;
  sourceAgent: string;
  targetAgent: string;
  /** 源 skill 目录(必须含 SKILL.md)。 */
  sourcePath: string;
  confirm?: boolean;
  /** 附加允许根(绝对路径,如清单池项目根)——项目内技能跨 Agent 同步的信任来源。 */
  extraRoots?: string[];
}

export interface SkillSyncOutcome {
  status: number;
  body: Record<string, unknown>;
}

/** 不支持目录同步的 Agent 的用户可读原因(UI 与 API 共用一份)。 */
export const SYNC_UNSUPPORTED_REASONS: Record<string, string> = {
  zcode: "zcode 通过插件市场管理 Skill,不支持目录同步",
  dsh: "dsh 无文件化 Skill 目录,不支持目录同步",
};

/**
 * sourcePath 白名单根(相对 home):只允许从本机 Agent 配置目录、共享 skill 根
 * 与项目工作区拷入——sourcePath 来自请求体,不做归属校验等于任意目录读入写盘。
 */
const SYNC_SOURCE_ROOTS = [".codex", ".claude", ".zcode", ".dsh", ".config/opencode", ".agents"];

function sourcePathAllowed(home: string, sourcePath: string, extraRoots?: string[]): boolean {
  const real = (p: string): string => {
    try { return realpathSync(p); } catch { return resolve(p); }
  };
  const src = real(sourcePath);
  const roots = [
    ...SYNC_SOURCE_ROOTS.map(r => real(join(home, r))),
    real(join(home, "Documents", "UGit")),
    ...(extraRoots ?? []).filter(r => typeof r === "string" && r.startsWith("/")).map(r => real(r)),
  ];
  return roots.some(r => src === r || src.startsWith(r + sep));
}

function md5Of(path: string): string {
  try { return createHash("md5").update(readFileSync(path)).digest("hex"); }
  catch { return "unknown"; }
}

/**
 * 跨 Agent skill 同步核心逻辑(纯函数化,home 可注入,供 API 路由与测试共用)。
 * 契约:sourcePath 是 skill 目录(与扫描器 sourcePath 一致),正文是其中的 SKILL.md。
 * 安全:skillName basename 白名单(防路径遍历);大小预算按递归目录内容计。
 */
export function performSkillSync(params: SkillSyncParams): SkillSyncOutcome {
  const {home, skillName, sourceAgent, targetAgent, sourcePath, confirm} = params;
  if (!skillName || !sourceAgent || !targetAgent || !sourcePath) {
    return {status: 400, body: {error: "MISSING_PARAMS"}};
  }
  // Fix MEDIUM-3: skillName basename 白名单(防路径遍历),在一切拼接前校验。
  // L-2 修复:不再子串禁 ".."(误杀 v1..v2),精确拒绝 "." / ".." 两个相对路径特例。
  if (basename(skillName) !== skillName || skillName.includes("\\") || skillName === "." || skillName === ".." || skillName === "") {
    return {status: 400, body: {error: "INVALID_SKILL_NAME", message: "skillName 不能包含路径分隔符"}};
  }
  const targetDir = skillSyncTargetDir(home, targetAgent);
  if (!targetDir) {
    return {status: 400, body: {error: "TARGET_NOT_SUPPORTED", message: SYNC_UNSUPPORTED_REASONS[targetAgent] ?? `${targetAgent} 不支持 skill 同步`}};
  }
  // 插件命名空间名(plugin:skill)落目标时剥前缀——目标 Agent 只识别裸目录名,
  // 冒号目录是扫描盲区(纯垃圾落盘)。
  const targetName = skillName.includes(":") ? skillName.split(":").pop()! : skillName;
  if (!targetName || basename(targetName) !== targetName || targetName === "." || targetName === "..") {
    return {status: 400, body: {error: "INVALID_SKILL_NAME", message: "skillName 不能包含路径分隔符"}};
  }
  // 归属校验(验收审计 B HIGH-1):源必须位于本机已知 skill 根之下。
  if (!sourcePathAllowed(home, sourcePath, params.extraRoots)) {
    return {status: 403, body: {error: "SOURCE_FORBIDDEN", message: "源目录不在允许的 skill 根范围内"}};
  }
  const targetPath = join(targetDir, targetName);

  // 安全检查:源必须存在且是目录。
  if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
    return {status: 404, body: {error: "SOURCE_NOT_FOUND", message: `源 skill 目录不存在: ${sourcePath}`}};
  }
  // Fix HIGH-2: 大小预算用递归目录内容大小(目录 inode size 恒小于 4KiB,不代表内容)。
  // Dirent.isDirectory() 基于 lstat,符号链接目录不递归,无循环风险。
  const dirSize = (dir: string): number => {
    let total = 0;
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const p = join(dir, entry.name);
      try {
        // L-1 修复:断链 symlink 等不可 stat 的条目按 0 计,不让整次同步 500。
        if (entry.isDirectory()) total += dirSize(p);
        else total += statSync(p).size;
      } catch { /* 不可读条目跳过 */ }
    }
    return total;
  };
  const sourceSize = dirSize(sourcePath);
  if (sourceSize > MAX_SYNC_BYTES) {
    return {status: 400, body: {error: "SOURCE_TOO_LARGE", message: `skill 目录 ${(sourceSize / 1024 / 1024).toFixed(1)}MiB 超过 5MiB 上限`}};
  }
  // 目标已存在且内容不同 → 需要 confirm(二次确认闸门)。
  if (existsSync(targetPath)) {
    const sourceMd5 = md5Of(join(sourcePath, "SKILL.md"));
    const targetMd5 = md5Of(join(targetPath, "SKILL.md"));
    if (sourceMd5 !== targetMd5 && !confirm) {
      return {
        status: 409,
        body: {
          error: "CONFIRM_REQUIRED",
          message: `目标已存在且内容不同(source=${sourceMd5.slice(0, 8)} target=${targetMd5.slice(0, 8)})。传 confirm: true 覆盖。`,
          sourceHash: sourceMd5,
          targetHash: targetMd5,
        },
      };
    }
  }

  // 执行复制。
  mkdirSync(targetDir, {recursive: true});
  cpSync(sourcePath, targetPath, {recursive: true});
  invalidateCapabilityScanCache();
  return {
    status: 200,
    body: {
      ok: true,
      skillName,
      sourceAgent,
      targetAgent,
      sourcePath,
      targetPath,
      message: `已将 ${skillName} 从 ${sourceAgent} 同步到 ${targetAgent}`,
    },
  };
}
