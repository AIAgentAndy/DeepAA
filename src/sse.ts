import type { CaptureParseError, CapturedSseEvent } from "./lib/harness/types.js";

/** SSE 事件中间表示，供 anthropic.ts / openai.ts 的流式重建逻辑使用 */
export interface SSEEvent {
  event: string;
  data: unknown;
  /** Raw string data before parsing */
  raw?: string;
}

export interface ParsedSSEStream {
  events: CapturedSseEvent[];
  parseErrors: CaptureParseError[];
  doneMarkerSeen: boolean;
}

export function parseSSEEvents(streamText: string): SSEEvent[] {
  return parseSSEStream(streamText).events.map(event => {
    const legacyEvent: SSEEvent = {
      event: event.event,
      data: event.data,
    };
    if (event.parseError) legacyEvent.raw = event.rawData;
    return legacyEvent;
  });
}

export function parseSSEStream(streamText: string): ParsedSSEStream {
  const events: CapturedSseEvent[] = [];
  const parseErrors: CaptureParseError[] = [];
  let doneMarkerSeen = false;

  for (const block of streamText.split(/\r?\n\r?\n/)) {
    const parsed = parseSSEBlock(block, events.length);
    if (!parsed) continue;
    if (parsed.doneMarkerSeen) {
      doneMarkerSeen = true;
      continue;
    }
    if (parsed.event.parseError) parseErrors.push(parsed.event.parseError);
    events.push(parsed.event);
  }

  return { events, parseErrors, doneMarkerSeen };
}

function parseSSEBlock(
  block: string,
  index: number
): { event: CapturedSseEvent; doneMarkerSeen?: boolean } | null {
  let eventName = "";
  const dataLines: string[] = [];

  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(":")) continue;

    const separatorIndex = rawLine.indexOf(":");
    const field = separatorIndex === -1 ? rawLine : rawLine.slice(0, separatorIndex);
    let value = separatorIndex === -1 ? "" : rawLine.slice(separatorIndex + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) return null;

  const raw = dataLines.join("\n");
  if (raw === "[DONE]") return {
    doneMarkerSeen: true,
    event: {
      index,
      event: "done",
      data: null,
      rawData: raw,
    },
  };

  try {
    const data = JSON.parse(raw);
    return {
      event: {
        index,
        event: eventName || eventNameFromData(data),
        data,
        rawData: raw,
      },
    };
  } catch {
    const parseError = {
      message: "SSE data JSON parse failed",
      rawPreview: raw.slice(0, 160),
    };
    return {
      event: {
        index,
        event: eventName || "parse_error",
        data: null,
        rawData: raw,
        parseError,
      },
    };
  }
}

function eventNameFromData(data: unknown): string {
  if (data && typeof data === "object" && "type" in data) {
    const type = (data as { type?: unknown }).type;
    if (typeof type === "string" && type) return type;
  }
  return "unknown";
}
