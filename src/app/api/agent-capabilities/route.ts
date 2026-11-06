import {jsonResponse} from "@/lib/app-state";
import {resolveDeepaaDataDir} from "@/lib/data-paths";
import {scanLocalCapabilities} from "@/lib/agent-capabilities/scanner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * P1-5（2026-11-03）：本机能力台账（只读有界扫描，60s 缓存）。
 * GET /api/agent-capabilities → 五 Agent 的 skills/MCP/插件/profiles 台账 +
 * 各渠道 candidateCount/processedCount/bytesRead/limited 可观测字段。
 * 不执行任何配置命令/脚本，不读取 SKILL.md 正文。
 */
export async function GET(): Promise<Response> {
  try {
    const ledgers = scanLocalCapabilities({dataDir: resolveDeepaaDataDir()});
    return jsonResponse({
      agents: ledgers,
      candidateCount: ledgers.length,
      processedCount: ledgers.length,
      limited: ledgers.some(ledger => ledger.scan.limited),
    });
  } catch (error) {
    return Response.json({error: "SCAN_FAILED", message: (error as Error).message}, {status: 500});
  }
}
