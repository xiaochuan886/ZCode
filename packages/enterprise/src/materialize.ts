import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

export interface CustomerWorkspaceInput {
  workspacePath: string;
  sharedSkills?: Array<{ id: string; name: string; content: string; sha256?: string }>;
  mcpServers?: Record<string, Record<string, unknown>>;
}

type WorkspaceMaterializeInput = {
  workspacePath: string;
  sharedSkills?: Array<{ id: string; name: string; content: string; sha256?: string }>;
  mcpServers?: Record<string, Record<string, unknown>>;
};

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const SKILL_PREFIX = "enterprise-";
const isManagedName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.startsWith(SKILL_PREFIX) &&
  SAFE_NAME.test(value.slice(SKILL_PREFIX.length));
interface ManagedNames {
  skills: string[];
  mcp: string[];
}
const emptyManaged = (): ManagedNames => ({ skills: [], mcp: [] });
const pending = new Map<string, Promise<unknown>>();

async function writeAtomic(path: string, content: string, mode = 0o600): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, mode);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function ensureRealDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Managed Customer directory must not be a symlink");
  }
}

async function readRegularFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Managed Customer file must be regular");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Managed Customer file must be regular");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function validateInput(input: WorkspaceMaterializeInput): void {
  if (!isAbsolute(input.workspacePath))
    throw new Error("Customer workspace path must be absolute");
  for (const skill of input.sharedSkills ?? []) {
    if (!SAFE_NAME.test(skill.id)) throw new Error("Invalid shared Skill ID");
    if (skill.sha256 && createHash("sha256").update(skill.content).digest("hex") !== skill.sha256) {
      throw new Error("Shared Skill content hash mismatch");
    }
  }
  for (const name of Object.keys(input.mcpServers ?? {})) {
    if (!SAFE_NAME.test(name)) throw new Error("Invalid MCP binding name");
  }
}

async function readManaged(path: string): Promise<ManagedNames> {
  try {
    const value: unknown = JSON.parse(await readRegularFile(path));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid enterprise managed manifest");
    const record = value as Record<string, unknown>;
    if (
      !Array.isArray(record.skills) ||
      !Array.isArray(record.mcp) ||
      ![...record.skills, ...record.mcp].every(isManagedName)
    ) {
      throw new Error("Invalid enterprise managed manifest");
    }
    return { skills: record.skills as string[], mcp: record.mcp as string[] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyManaged();
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readMcpConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readRegularFile(path));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Workspace MCP config must be an object");
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function serverMap(current: Record<string, unknown>): Record<string, unknown> {
  const mcp = current.mcp;
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return {};
  const servers = (mcp as Record<string, unknown>).servers;
  return servers && typeof servers === "object" && !Array.isArray(servers)
    ? (servers as Record<string, unknown>)
    : {};
}

async function syncSkills(
  input: WorkspaceMaterializeInput,
  previous: ManagedNames,
): Promise<string[]> {
  const root = join(input.workspacePath, ".zcode", "skills");
  await ensureRealDirectory(join(input.workspacePath, ".zcode"));
  await ensureRealDirectory(root);
  const desired = new Set((input.sharedSkills ?? []).map((skill) => `${SKILL_PREFIX}${skill.id}`));
  for (const name of previous.skills) {
    if (!desired.has(name)) await rm(join(root, name), { recursive: true, force: true });
  }
  for (const skill of input.sharedSkills ?? []) {
    const directory = join(root, `${SKILL_PREFIX}${skill.id}`);
    await ensureRealDirectory(directory);
    await writeAtomic(join(directory, "SKILL.md"), skill.content);
  }
  return [...desired];
}

async function syncMcp(
  input: WorkspaceMaterializeInput,
  previous: ManagedNames,
  current: Record<string, unknown>,
): Promise<string[]> {
  const directory = join(input.workspacePath, ".zcode");
  const configPath = join(directory, "config.json");
  await ensureRealDirectory(directory);
  const mcp =
    current.mcp && typeof current.mcp === "object" && !Array.isArray(current.mcp)
      ? (current.mcp as Record<string, unknown>)
      : {};
  const existing = serverMap(current);
  const servers = Object.fromEntries(
    Object.entries(existing).filter(([name]) => !previous.mcp.includes(name)),
  );
  const desired: string[] = [];
  for (const [name, config] of Object.entries(input.mcpServers ?? {})) {
    const managedName = `${SKILL_PREFIX}${name}`;
    servers[managedName] = config;
    desired.push(managedName);
  }
  await writeAtomic(
    configPath,
    `${JSON.stringify({ ...current, mcp: { ...mcp, servers } }, null, 2)}\n`,
  );
  return desired;
}

async function prepareCustomerOnce(
  input: CustomerWorkspaceInput,
): Promise<{ skillCount: number; mcpCount: number }> {
  validateInput(input);
  await ensureRealDirectory(input.workspacePath);
  await ensureRealDirectory(join(input.workspacePath, ".zcode"));
  // 客户 workspace 的文件和记忆由 Native workspace 所有；企业层只同步自己托管的 Skill/MCP。
  const manifestRoot = join(dirname(input.workspacePath), ".enterprise-managed");
  await ensureRealDirectory(manifestRoot);
  const manifestPath = join(manifestRoot, `${basename(input.workspacePath)}.json`);
  const previous = await readManaged(manifestPath);
  const config = await readMcpConfig(join(input.workspacePath, ".zcode", "config.json"));
  const nextSkills = (input.sharedSkills ?? []).map((skill) => `${SKILL_PREFIX}${skill.id}`);
  const nextMcp = Object.keys(input.mcpServers ?? {}).map((name) => `${SKILL_PREFIX}${name}`);
  for (const name of nextSkills) {
    if (
      !previous.skills.includes(name) &&
      (await exists(join(input.workspacePath, ".zcode", "skills", name)))
    ) {
      throw new Error(`Shared Skill name conflicts with native Skill: ${name}`);
    }
  }
  for (const name of nextMcp) {
    if (!previous.mcp.includes(name) && Object.hasOwn(serverMap(config), name)) {
      throw new Error(`MCP binding name conflicts with native MCP: ${name}`);
    }
  }
  await writeAtomic(
    manifestPath,
    `${JSON.stringify({ skills: [...new Set([...previous.skills, ...nextSkills])], mcp: [...new Set([...previous.mcp, ...nextMcp])] })}\n`,
  );
  const skills = await syncSkills(input, previous);
  const mcp = await syncMcp(input, previous, config);
  await writeAtomic(manifestPath, `${JSON.stringify({ skills, mcp })}\n`);
  return { skillCount: skills.length, mcpCount: mcp.length };
}

/** Materialize only customer-scoped enterprise inputs without touching native context files. */
export async function prepareCustomerWorkspace(
  input: CustomerWorkspaceInput,
): Promise<{ skillCount: number; mcpCount: number }> {
  const prior = pending.get(input.workspacePath) ?? Promise.resolve();
  const operation = prior.catch(() => undefined).then(() => prepareCustomerOnce(input));
  pending.set(input.workspacePath, operation);
  try {
    return await operation;
  } finally {
    if (pending.get(input.workspacePath) === operation) pending.delete(input.workspacePath);
  }
}
