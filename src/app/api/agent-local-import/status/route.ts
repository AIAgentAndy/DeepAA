import {resolveDeepaaDataDir} from "@/lib/data-paths";
import {readAgentLocalImportStatus} from "@/lib/agent-local-source/local-import-scheduler";
import {jsonResponse} from "@/lib/app-state";

export const dynamic = "force-dynamic";

/** 双链路观测导入状态（只读）：绑定推导 + 数据源探测 + 导入进度。绝不触发导入。 */
export async function GET() {
  const dataDir = resolveDeepaaDataDir();
  const agents = await readAgentLocalImportStatus(dataDir);
  return jsonResponse({agents});
}
