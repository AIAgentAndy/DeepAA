import { resolveDeepaaDataDir } from "@/lib/data-paths";
import { getDeepaaDatabase } from "@/lib/db/connection";
import {
  assertNoRawRange,
  assertRawStreamRequest,
} from "@/lib/raw-stream-gateway";
import {
  openWorkbenchRawInspectorBodyResponse,
  workbenchRawInspectorErrorResponse,
  WorkbenchRawInspectorError,
} from "@/lib/workbench-raw-inspector";
import type { WorkbenchRawInspectorSide } from "@/lib/workbench-raw-inspector-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ exchangeId: string; side: string }> },
): Promise<Response> {
  try {
    assertRawStreamRequest(request);
    assertNoRawRange(request);
    const { exchangeId, side } = await context.params;
    const dataDir = resolveDeepaaDataDir();
    return await openWorkbenchRawInspectorBodyResponse({
      db: getDeepaaDatabase(dataDir),
      dataDir,
      exchangeId: decodeExchangeId(exchangeId),
      side: parseSide(side),
    });
  } catch (error) {
    return workbenchRawInspectorErrorResponse(error);
  }
}

function parseSide(value: string): WorkbenchRawInspectorSide {
  if (value === "request" || value === "response") return value;
  throw new WorkbenchRawInspectorError(
    "invalid_raw_inspector_side",
    400,
    "Inspector side 无效。",
  );
}

function decodeExchangeId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new WorkbenchRawInspectorError(
      "invalid_exchange_id",
      400,
      "Exchange ID 无效。",
    );
  }
}
