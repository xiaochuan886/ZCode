import { EnterpriseError, type TenantMcpConnectorAuthMode } from "./types.js";

/** Stable slug identifying a system connector inside its tenant; also the managed MCP name suffix. */
export const CONNECTOR_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** RFC 7230 token characters; header names must be safe to inject verbatim upstream. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/;
const OAUTH_FIELD_KEYS = ["authorizeUrl", "tokenUrl", "clientId", "clientSecret", "scopes"] as const;

export interface TenantMcpConnectorInput {
  connectorKey: string;
  displayName: string;
  url: string;
  headerName?: string;
  /** shared 模式必填;user-oauth 模式禁止。 */
  secretEnv?: string;
  enabled?: boolean;
  authMode?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  /** 留空(编辑时)表示保留现有密文;公共客户端可无 secret。 */
  clientSecret?: string;
  /** 单个空格分隔的 scope 串。 */
  scopes?: string;
}

export interface TenantMcpConnectorPatch {
  connectorKey?: string;
  displayName?: string;
  url?: string;
  headerName?: string;
  secretEnv?: string;
  enabled?: boolean;
  authMode?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
}

export const invalid = (): never => {
  // Never include supplied values in errors; they may contain live secret references.
  throw new EnterpriseError("validation");
};

export function validateConnectorKey(value: string): string {
  if (typeof value !== "string" || !CONNECTOR_KEY_PATTERN.test(value)) return invalid();
  return value;
}

export function validateDisplayName(value: string): string {
  if (typeof value !== "string") return invalid();
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || normalized.includes("\0")) return invalid();
  return normalized;
}

export function validateUrl(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return invalid();
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return invalid();
  }
  if (parsed.username || parsed.password || parsed.hash) return invalid();
  return trimmed;
}

export function validateHeaderName(value: string | undefined): string {
  if (value === undefined || value === "") return "Authorization";
  if (typeof value !== "string") return invalid();
  const normalized = value.trim();
  if (!HEADER_NAME_PATTERN.test(normalized)) return invalid();
  return normalized;
}

export function validateSecretEnv(value: string): string {
  if (typeof value !== "string") return invalid();
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /\s/.test(normalized) || normalized.includes("\0"))
    return invalid();
  return normalized;
}

/** OAuth authorize/token URL:干净 https 地址,不允许 userinfo/fragment。 */
export function validateOauthUrl(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return invalid();
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return invalid();
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  )
    return invalid();
  return trimmed;
}

export function validateOauthClientId(value: string): string {
  if (typeof value !== "string") return invalid();
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || normalized.includes("\0")) return invalid();
  return normalized;
}

export function validateScopes(value: string | undefined): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.includes("\0") || value.length > 512) return invalid();
  return value.trim();
}

export function normalizeAuthMode(value: string | undefined): TenantMcpConnectorAuthMode {
  if (value === undefined || value === "shared") return "shared";
  if (value === "user-oauth") return "user-oauth";
  return invalid();
}

export function hasOauthField(
  input: TenantMcpConnectorInput | TenantMcpConnectorPatch,
): boolean {
  return OAUTH_FIELD_KEYS.some((key) => {
    const value = input[key];
    return typeof value === "string" && value.trim() !== "";
  });
}

export function endpointHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export interface McpConnectorForRelay {
  id: string;
  tenantId: string;
  url: string;
  headerName: string;
  secretEnv: string;
}
