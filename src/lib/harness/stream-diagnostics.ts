import { classifyProtocol } from "./protocol";
import type { EvidencePointer, RawCapturedExchange } from "./types";

export type StreamDiagnosticStatus =
  | "complete"
  | "terminal_missing"
  | "sse_parse_empty"
  | "stream_truncated"
  | "client_aborted"
  | "upstream_aborted"
  | "connection_error"
  | "upstream_error"
  | "unknown";

export interface RefinedStreamDiagnostic {
  exchangeId: string;
  status: StreamDiagnosticStatus;
  protocol: string;
  connectionStatus:
    | "open_completed"
    | "client_aborted"
    | "upstream_aborted"
    | "connection_reset"
    | "proxy_stream_error"
    | "unknown";
  protocolStatus:
    | "terminal_seen"
    | "terminal_missing"
    | "parse_empty"
    | "truncated"
    | "provider_error"
    | "unknown";
  expectedTerminalEvents: string[];
  terminalEventSeen: boolean;
  doneMarkerSeen?: boolean;
  lastEvent?: string;
  eventCount: number;
  receivedBytes: number;
  parseErrorCount: number;
  message: string;
  evidence: EvidencePointer[];
}

export function refineStreamDiagnostic(exchange: RawCapturedExchange): RefinedStreamDiagnostic {
  const protocol = classifyProtocol(exchange).protocol;
  const expectedTerminalEvents = expectedTerminalFor(protocol);
  const events = exchange.stream?.events || [];
  const lifecycle = exchange.stream?.lifecycleSummary;
  const lastEvent = lifecycle?.lastEventType ?? events.at(-1)?.event;
  const providerTerminalStatus = lifecycle
    ? providerTerminalStatusFromLifecycle(lifecycle.providerStatus)
    : providerTerminalStatusFrom(events);
  const terminalEventSeen = lifecycle?.terminalEventSeen
    ?? (
      expectedTerminalEvents.some(eventName =>
        events.some(event => event.event === eventName))
      || !!exchange.stream?.doneMarkerSeen && expectedTerminalEvents.includes("[DONE]")
    );
  const connectionStatus = connectionStatusFromDiagnostics(exchange);
  const protocolStatus = terminalEventSeen
    ? "terminal_seen"
    : providerTerminalStatus
      ? providerTerminalStatus
      : events.length === 0 && exchange.response.isStreaming
      ? "parse_empty"
      : "terminal_missing";
  const status = statusFrom(connectionStatus, protocolStatus, exchange.response.status);
  return {
    exchangeId: exchange.exchangeId,
    status,
    protocol,
    connectionStatus,
    protocolStatus,
    expectedTerminalEvents,
    terminalEventSeen,
    doneMarkerSeen: lifecycle?.doneMarkerSeen ?? exchange.stream?.doneMarkerSeen,
    lastEvent,
    eventCount: lifecycle?.eventCount ?? events.length,
    receivedBytes: exchange.response.bodySizeBytes,
    parseErrorCount: lifecycle?.parseErrorCount
      ?? exchange.stream?.parseErrors.length
      ?? 0,
    message: diagnosticMessage(status),
    evidence: [{ exchangeId: exchange.exchangeId, side: "stream", path: "$.stream" }],
  };
}

function providerTerminalStatusFromLifecycle(
  status: "completed" | "failed" | "incomplete" | "cancelled" | undefined,
): RefinedStreamDiagnostic["protocolStatus"] | undefined {
  if (status === "failed") return "provider_error";
  if (status === "incomplete" || status === "cancelled") return "truncated";
  return undefined;
}

function expectedTerminalFor(protocol: string): string[] {
  if (protocol === "anthropic-messages") return ["message_stop"];
  if (protocol === "openai-responses") return ["response.completed"];
  if (protocol === "openai-chat-completions") return ["[DONE]"];
  return [];
}

function connectionStatusFromDiagnostics(exchange: RawCapturedExchange): RefinedStreamDiagnostic["connectionStatus"] {
  const codes = exchange.captureDiagnostics.map(item => item.code);
  if (codes.includes("client_aborted")) return "client_aborted";
  if (codes.includes("upstream_aborted")) return "upstream_aborted";
  if (codes.includes("connection_reset")) return "connection_reset";
  if (codes.includes("proxy_error")) return "proxy_stream_error";
  return "open_completed";
}

function statusFrom(
  connectionStatus: RefinedStreamDiagnostic["connectionStatus"],
  protocolStatus: RefinedStreamDiagnostic["protocolStatus"],
  httpStatus: number
): StreamDiagnosticStatus {
  if (httpStatus >= 400) return "upstream_error";
  if (protocolStatus === "provider_error") return "upstream_error";
  if (protocolStatus === "truncated") return "stream_truncated";
  if (protocolStatus === "terminal_seen") return "complete";
  if (connectionStatus === "client_aborted") return "client_aborted";
  if (connectionStatus === "upstream_aborted") return "upstream_aborted";
  if (connectionStatus === "connection_reset" || connectionStatus === "proxy_stream_error") return "connection_error";
  if (protocolStatus === "parse_empty") return "sse_parse_empty";
  if (protocolStatus === "terminal_missing") return "terminal_missing";
  return "unknown";
}

function providerTerminalStatusFrom(events: Array<{ event: string }>): RefinedStreamDiagnostic["protocolStatus"] | undefined {
  const eventNames = events.map(event => event.event);
  if (eventNames.some(event => event === "response.failed" || event === "error")) return "provider_error";
  if (eventNames.some(event => event === "response.incomplete")) return "truncated";
  return undefined;
}

function diagnosticMessage(status: StreamDiagnosticStatus): string {
  switch (status) {
    case "complete":
      return "Stream completed with expected terminal marker.";
    case "client_aborted":
      return "Client side ended the stream before protocol terminal marker.";
    case "upstream_aborted":
      return "Upstream ended the stream before protocol terminal marker.";
    case "sse_parse_empty":
      return "SSE raw body is present but no events were parsed.";
    default:
      return `Stream diagnostic status: ${status}.`;
  }
}
