import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export type McpDnsAddress = { address: string; family: number };
export type McpDnsLookup = (hostname: string) => Promise<McpDnsAddress[]>;

const blockedIpv6Subnets = ["2001:2::/48", "2001:10::/28", "2001:20::/28"].map((cidr) =>
  ipaddr.IPv6.parseCIDR(cidr),
);

function publicUnicastAddress(address: string, family: number): boolean {
  try {
    const parsed = ipaddr.process(address);
    if (parsed.kind() === "ipv4") return family === 4 && parsed.range() === "unicast";
    const ipv6 = parsed as ipaddr.IPv6;
    return (
      family === 6 &&
      ipv6.range() === "unicast" &&
      (ipv6.parts[0]! & 0xe000) === 0x2000 &&
      !blockedIpv6Subnets.some((subnet) => ipv6.match(subnet))
    );
  } catch {
    return false;
  }
}

export const systemMcpDnsLookup: McpDnsLookup = async (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

export async function resolvePublicMcpAddress(
  hostname: string,
  resolver: McpDnsLookup = systemMcpDnsLookup,
): Promise<McpDnsAddress> {
  const addresses = await resolver(hostname);
  if (
    !addresses.length ||
    addresses.some(({ address, family }) => !publicUnicastAddress(address, family))
  ) {
    throw new Error("MCP endpoint resolves to a non-public address");
  }
  return addresses[0]!;
}

const secretPrefix = "ZCODE_ENTERPRISE_MCP_SECRET_";
const allowlistEnvironmentKey = "ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON";

function compactTenantId(tenantId: string): string | null {
  const compact = tenantId.replaceAll("-", "").toUpperCase();
  return /^[0-9A-F]{32}$/.test(compact) ? compact : null;
}

function safeHttpsUrl(value: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const hostname = parsed.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    !hostname ||
    isIP(hostname) !== 0 ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost")
  ) {
    return null;
  }
  return parsed;
}

function tenantAllowlist(tenantId: string, raw: string | undefined): URL[] | null {
  const tenantKey = compactTenantId(tenantId);
  if (!tenantKey || !raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  let matchingEntry: URL[] | null = null;
  for (const [configuredTenantId, configuredValues] of Object.entries(parsed)) {
    const configuredTenantKey = compactTenantId(configuredTenantId);
    if (!configuredTenantKey || !Array.isArray(configuredValues)) return null;
    const endpoints: URL[] = [];
    for (const value of configuredValues) {
      if (typeof value !== "string") return null;
      const endpoint = safeHttpsUrl(value);
      if (!endpoint) return null;
      endpoints.push(endpoint);
    }
    if (configuredTenantKey === tenantKey) {
      if (matchingEntry) return null;
      matchingEntry = endpoints;
    }
  }
  return matchingEntry;
}

export function tenantMcpSecretRefPrefix(tenantId: string): string | null {
  const tenantKey = compactTenantId(tenantId);
  return tenantKey ? `${secretPrefix}${tenantKey}_` : null;
}

export function isTenantMcpSecretRef(secretRef: string, tenantId: string): boolean {
  const prefix = tenantMcpSecretRefPrefix(tenantId);
  if (!prefix || !secretRef.startsWith(prefix)) return false;
  return /^[A-Z0-9_]{1,100}$/.test(secretRef.slice(prefix.length));
}

export function isTenantMcpEndpointAllowed(
  tenantId: string,
  endpoint: string,
  rawAllowlist = process.env[allowlistEnvironmentKey],
): boolean {
  const parsedEndpoint = safeHttpsUrl(endpoint);
  const allowedValues = tenantAllowlist(tenantId, rawAllowlist);
  if (!parsedEndpoint || !allowedValues) return false;

  return allowedValues.some((allowed) => {
    const isOrigin = allowed.pathname === "/" && !allowed.search;
    return isOrigin
      ? parsedEndpoint.origin === allowed.origin
      : parsedEndpoint.href === allowed.href;
  });
}
