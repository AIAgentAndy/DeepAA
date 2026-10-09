import {join} from "node:path";
import {resolveDeepaaDataDir} from "./lib/data-paths.js";
import {ProxyExchangeStore} from "./proxy/exchange-store.js";
import {startProxy} from "./reverse-proxy.js";

const PROXY_RUNTIME_VERSION = "2";
const dataDir = resolveDeepaaDataDir();
const configPath = join(dataDir, "proxy-config.json");
const statusPath = join(dataDir, "proxy-routing-status.json");
const store = new ProxyExchangeStore({dataDir});

await store.init();
const proxy = await startProxy(store, {configPath, statusPath});
const state = store.runtimeState();

process.stdout.write(`${JSON.stringify({
  event: "proxy-ready",
  host: proxy.hostname,
  port: proxy.port,
  instanceId: proxy.routing.proxyInstanceId,
  version: PROXY_RUNTIME_VERSION,
  appliedRevision: proxy.routing.current().revision,
  captureDegraded: state.captureDegraded,
})}\n`);

let shutdownPromise: Promise<void> | undefined;
function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  shutdownPromise ??= (async () => {
    process.stdout.write(`${JSON.stringify({event: "proxy-stopping", signal})}\n`);
    await proxy.close();
    process.stdout.write(`${JSON.stringify({
      event: "proxy-stopped",
      capture: store.runtimeState(),
    })}\n`);
  })();
  return shutdownPromise;
}

process.once("SIGINT", () => {
  void shutdown("SIGINT").catch(reportShutdownFailure);
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM").catch(reportShutdownFailure);
});

function reportShutdownFailure(error: unknown): void {
  process.stderr.write(`${JSON.stringify({
    event: "proxy-shutdown-error",
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
}
