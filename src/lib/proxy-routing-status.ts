import {join} from "node:path";
import {connect} from "node:net";
import {setTimeout as delay} from "node:timers/promises";
import {readFileBounded} from "@/proxy/atomic-file";
import type {RoutingAppliedStatus} from "@/proxy/routing-config";

const MAX_ROUTING_STATUS_BYTES = 16 * 1024;

export function proxyRoutingStatusPath(dataDir: string): string {
  return join(dataDir, "proxy-routing-status.json");
}

export async function readRoutingAppliedStatus(
  statusPath: string,
): Promise<RoutingAppliedStatus | undefined> {
  try {
    const raw = await readFileBounded(statusPath, MAX_ROUTING_STATUS_BYTES);
    return parseAppliedStatus(JSON.parse(raw.toString("utf8")));
  } catch {
    return undefined;
  }
}

export async function waitForRoutingRevision(
  statusPath: string,
  revision: number,
  options: {timeoutMs?: number; pollIntervalMs?: number} = {},
): Promise<RoutingAppliedStatus | undefined> {
  if (!Number.isSafeInteger(revision) || revision < 1) return undefined;
  const timeoutMs = options.timeoutMs ?? 1_500;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const status = await readRoutingAppliedStatus(statusPath);
    if (status && status.appliedRevision >= revision) return status;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    await delay(Math.min(pollIntervalMs, remaining));
  }
}

export async function isRoutingRevisionApplied(
  dataDir: string,
  revision: number | undefined,
  localProxyBaseUrl = `http://127.0.0.1:${process.env.PROXY_PORT || "3211"}`,
): Promise<boolean> {
  if (!Number.isSafeInteger(revision) || (revision ?? 0) < 1) return false;
  const status = await readRoutingAppliedStatus(proxyRoutingStatusPath(dataDir));
  if (!status || status.appliedRevision < (revision as number)) return false;
  return await canConnectToProxy(localProxyBaseUrl);
}

async function canConnectToProxy(localProxyBaseUrl: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(localProxyBaseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const host = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  return await new Promise(resolve => {
    let settled = false;
    const socket = connect({host, port});
    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(connected);
    };
    const timer = setTimeout(() => finish(false), 300);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function parseAppliedStatus(raw: unknown): RoutingAppliedStatus | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(value.appliedRevision) || (value.appliedRevision as number) < 1) {
    return undefined;
  }
  if (typeof value.proxyInstanceId !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(value.proxyInstanceId)) {
    return undefined;
  }
  if (typeof value.appliedAt !== "string" || Number.isNaN(Date.parse(value.appliedAt))) {
    return undefined;
  }
  return {
    appliedRevision: value.appliedRevision as number,
    proxyInstanceId: value.proxyInstanceId,
    appliedAt: value.appliedAt,
  };
}
