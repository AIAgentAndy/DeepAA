/**
 * 经 HTTP CONNECT 隧道的 https Agent（2026-10-08 用户确认，仅官方上游白名单使用）。
 *
 * 零第三方依赖：复用 Node `https.Agent` 的池化/keep-alive，仅按连接覆写
 * `createConnection`——先与代理建立 TCP、发送 `CONNECT host:port`、等待 2xx
 * 响应头，再在隧道上做 TLS 握手。隧道建立失败以稳定错误回调，不影响其它连接。
 */
import type {AgentOptions} from "node:http";
import {Agent as HttpsAgent} from "node:https";
import net from "node:net";
import tls from "node:tls";
import type {UpstreamProxyEndpoint} from "./official-upstream";

/** CONNECT 响应头缓冲上限：合法代理只回状态行 + 少量头，超限视为异常代理。 */
const CONNECT_RESPONSE_LIMIT_BYTES = 8_192;

type TunnelCreateConnectionOptions = {
  host?: string;
  port?: number;
  servername?: string;
} & Record<string, unknown>;

/**
 * 创建走 CONNECT 隧道的 https Agent。返回类型保持 `HttpsAgent`，
 * 与直连 Agent 在池化结构中同型，不引入新的类型分支。
 */
export function createConnectTunnelHttpsAgent(
  proxy: UpstreamProxyEndpoint,
  options?: AgentOptions,
  tlsOptions: Pick<tls.ConnectionOptions, "rejectUnauthorized"> = {},
): HttpsAgent {
  const agent = new HttpsAgent(options);
  // 运行时按实例覆写 createConnection：Node http.Agent 的 createSocket 以
  // (options, oncreate) 调用，回调形态与直连 tls.createConnection 兼容。
  (agent as unknown as {
    createConnection: (
      options: TunnelCreateConnectionOptions,
      callback: (error: Error | null, socket?: tls.TLSSocket) => void,
    ) => void;
  }).createConnection = (options, callback) => {
    let settled = false;
    const settle = (error: Error | null, socket?: tls.TLSSocket): void => {
      if (settled) return;
      settled = true;
      callback(error, socket);
    };
    const host = typeof options.host === "string" ? options.host : "";
    const port = Number(options.port ?? 443);
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) {
      settle(new Error("TUNNEL_TARGET_INVALID"));
      return;
    }
    const socket = net.connect({host: proxy.host, port: proxy.port});
    socket.once("error", error => settle(error));
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      const head = Buffer.concat(chunks);
      const separator = head.indexOf("\r\n\r\n");
      if (separator === -1) {
        if (head.length > CONNECT_RESPONSE_LIMIT_BYTES) {
          socket.removeListener("data", onData);
          socket.destroy();
          settle(new Error("UPSTREAM_PROXY_RESPONSE_TOO_LARGE"));
        }
        return;
      }
      socket.removeListener("data", onData);
      socket.removeListener("error", failSocket);
      const statusLine = head.toString("latin1", 0, separator).split("\r\n", 1)[0] ?? "";
      if (!/^HTTP\/1\.[01]\s+2\d\d/u.test(statusLine)) {
        socket.destroy();
        settle(new Error(`UPSTREAM_PROXY_TUNNEL_DENIED: ${statusLine.slice(0, 64)}`));
        return;
      }
      const tlsSocket = tls.connect({
        socket,
        servername: options.servername || host,
        rejectUnauthorized: tlsOptions.rejectUnauthorized ?? true,
      });
      settle(null, tlsSocket);
    };
    const failSocket = (error: Error): void => {
      socket.removeListener("data", onData);
      settle(error);
    };
    socket.once("error", failSocket);
    socket.once("connect", () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    socket.on("data", onData);
  };
  return agent;
}
