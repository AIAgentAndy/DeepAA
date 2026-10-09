import { resolveDeepaaDataDir } from "@/lib/data-paths";
import { getDeepaaDatabase } from "@/lib/db/connection";
import {
  assertNoRawRange,
  assertRawStreamRequest,
} from "@/lib/raw-stream-gateway";
import {
  loadWorkbenchRawInspectorMetadata,
  workbenchRawInspectorErrorResponse,
  workbenchRawInspectorHeaders,
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
    const metadata = await loadWorkbenchRawInspectorMetadata(
      getDeepaaDatabase(dataDir),
      dataDir,
      decodeExchangeId(exchangeId),
      parseSide(side),
    );
    return Response.json(metadata, {
      headers: workbenchRawInspectorHeaders("application/json; charset=utf-8"),
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
