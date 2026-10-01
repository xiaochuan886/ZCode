import { Agent, buildConnector } from "undici";
import { resolvePublicMcpAddress, type McpDnsLookup } from "./mcp-policy.js";

export const upstreamHeaderTimeoutMs = 15_000;
const dnsResolveTimeoutMs = 5_000;

/** 连接器 relay 的网络层辅助:DNS 公网解析超时与按解析地址 pin 的 upstream Agent。 */
export function pinnedAgent(endpoint: URL, address: { address: string; family: number }): Agent {
  const connector = buildConnector({ timeout: upstreamHeaderTimeoutMs });
  const pinnedConnector: buildConnector.connector = (options, callback) =>
    connector(
      {
        ...options,
        hostname: address.address,
        host: address.address,
        servername: endpoint.hostname,
      },
      callback,
    );
  return new Agent({
    connect: pinnedConnector,
    connections: 1,
    pipelining: 0,
    headersTimeout: upstreamHeaderTimeoutMs,
    bodyTimeout: 0,
  });
}

export async function resolveWithTimeout(
  hostname: string,
  dnsLookup: McpDnsLookup,
): Promise<{ address: string; family: number }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolvePublicMcpAddress(hostname, dnsLookup),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("MCP DNS lookup timed out")),
          dnsResolveTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
