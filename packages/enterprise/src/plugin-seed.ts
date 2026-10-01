import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeAtomic } from "./materialize.js";
import { syncSeededTree } from "./seed-sync.js";

const OFFICIAL_MARKET = "zcode-plugins-official";
const PLUGIN_STORAGE_ROOT = join(".zcode", "cli", "plugins");
const PLUGIN_CACHE_ROOT = join(PLUGIN_STORAGE_ROOT, "cache", OFFICIAL_MARKET);
const CLI_CONFIG_PATH = join(".zcode", "cli", "config.json");
const INSTALL_REGISTRY_FILE = "installed_plugins.json";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Key-order-independent deep equality, so a pure reformat never counts as a change. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

function warnSkippedMerge(path: string, code: string, reason: string): void {
  process.emitWarning(`Plugin seed skipped ${path}: existing ${reason}; merge refused.`, { code });
}

/** One seeded `<name>/<version>` unit, collapsed to the newest version per id. */
function collectRegistryUnits(units: string[]): Array<{ name: string; version: string }> {
  const latest = new Map<string, { name: string; version: string }>();
  for (const unit of units) {
    const separator = unit.indexOf("/");
    if (separator <= 0 || separator === unit.length - 1) continue;
    const name = unit.slice(0, separator);
    latest.set(`${name}@${OFFICIAL_MARKET}`, { name, version: unit.slice(separator + 1) });
  }
  return [...latest.values()];
}

/**
 * Merge the enabled entries into the expert's native CLI config. The file is
 * native state the gateway does not own: every existing key survives, the write
 * happens only when the merged content actually differs from what is on disk,
 * and a file that cannot be safely parsed or merged is left byte-identical
 * with a warning instead of being destroyed.
 */
async function enableSeededPlugins(configPath: string, names: string[]): Promise<void> {
  let raw: string | undefined;
  let current: unknown = {};
  try {
    raw = await readFile(configPath, "utf8");
    current = JSON.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      raw = undefined;
    } else if (error instanceof SyntaxError) {
      warnSkippedMerge(
        configPath,
        "ZCODE_ENTERPRISE_PLUGIN_CONFIG_INVALID",
        "CLI config is not valid JSON",
      );
      return;
    } else {
      throw error;
    }
  }
  if (!isPlainObject(current)) {
    warnSkippedMerge(
      configPath,
      "ZCODE_ENTERPRISE_PLUGIN_CONFIG_INVALID",
      "CLI config is not a JSON object",
    );
    return;
  }
  const plugins = current.plugins;
  if (plugins !== undefined && !isPlainObject(plugins)) {
    warnSkippedMerge(
      configPath,
      "ZCODE_ENTERPRISE_PLUGIN_CONFIG_INVALID",
      "CLI config has a non-object `plugins` key",
    );
    return;
  }
  const enabledPlugins = isPlainObject(plugins) ? plugins.enabledPlugins : undefined;
  if (enabledPlugins !== undefined && !isPlainObject(enabledPlugins)) {
    warnSkippedMerge(
      configPath,
      "ZCODE_ENTERPRISE_PLUGIN_CONFIG_INVALID",
      "CLI config has a non-object `plugins.enabledPlugins` key",
    );
    return;
  }
  const mergedEnabled: Record<string, unknown> = { ...enabledPlugins };
  for (const name of names) mergedEnabled[`${name}@${OFFICIAL_MARKET}`] = true;
  const merged: Record<string, unknown> = {
    ...current,
    plugins: { ...(isPlainObject(plugins) ? plugins : {}), enabledPlugins: mergedEnabled },
  };
  if (raw !== undefined && stableStringify(merged) === stableStringify(current)) return;
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeAtomic(configPath, `${JSON.stringify(merged, null, 2)}\n`);
}

/**
 * Merge the install registry (`<storageRoot>/installed_plugins.json`). The
 * agent's official-cache scan is restricted by a whitelist it rewrites from
 * image assets on every startup, so the cache copy alone stays invisible; the
 * install registry is loaded without any whitelist and is what makes seeded
 * plugins discoverable. `installPath` stays the empty string so resolution
 * falls back to the seeded cache directory instead of embedding absolute HOME
 * paths. Foreign records are never removed; upserts by id preserve the
 * existing `installedAt` and any fields the gateway does not own.
 */
async function registerInstalledPlugins(
  registryPath: string,
  seeded: Array<{ name: string; version: string }>,
): Promise<void> {
  let raw: string | undefined;
  let current: unknown = { version: 1, plugins: [] };
  try {
    raw = await readFile(registryPath, "utf8");
    current = JSON.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      raw = undefined;
    } else if (error instanceof SyntaxError) {
      warnSkippedMerge(
        registryPath,
        "ZCODE_ENTERPRISE_PLUGIN_INSTALL_INVALID",
        "install registry is not valid JSON",
      );
      return;
    } else {
      throw error;
    }
  }
  if (!isPlainObject(current)) {
    warnSkippedMerge(
      registryPath,
      "ZCODE_ENTERPRISE_PLUGIN_INSTALL_INVALID",
      "install registry is not a JSON object",
    );
    return;
  }
  const plugins = current.plugins;
  if (plugins !== undefined && !Array.isArray(plugins)) {
    warnSkippedMerge(
      registryPath,
      "ZCODE_ENTERPRISE_PLUGIN_INSTALL_INVALID",
      "install registry has a non-array `plugins` key",
    );
    return;
  }
  const existing = Array.isArray(plugins) ? plugins : [];
  const indexById = new Map<string, number>();
  existing.forEach((record, index) => {
    if (isPlainObject(record) && typeof record.id === "string") indexById.set(record.id, index);
  });
  const next = [...existing];
  for (const unit of seeded) {
    const id = `${unit.name}@${OFFICIAL_MARKET}`;
    const index = indexById.get(id);
    if (index === undefined) {
      next.push({
        id,
        name: unit.name,
        marketplace: OFFICIAL_MARKET,
        version: unit.version,
        installPath: "",
        installedAt: new Date().toISOString(),
        scope: "user",
      });
      continue;
    }
    next[index] = {
      ...next[index]!,
      name: unit.name,
      marketplace: OFFICIAL_MARKET,
      version: unit.version,
      installPath: "",
      scope: "user",
    };
  }
  const merged: Record<string, unknown> = { ...current, version: 1, plugins: next };
  if (raw !== undefined && stableStringify(merged) === stableStringify(current)) return;
  await mkdir(dirname(registryPath), { recursive: true, mode: 0o700 });
  await writeAtomic(registryPath, `${JSON.stringify(merged, null, 2)}\n`);
}

/**
 * 基线插件种子:容器 agent 不会自行获取插件内容,但预置的
 * `~/.zcode/cli/plugins/cache/zcode-plugins-official/<name>/<version>/` 目录
 * 在会话启动时完全离线可用(skill/command 扫描只读本地磁盘)。prepare 时把
 * operator 通过 `ZCODE_ENTERPRISE_PLUGIN_SEED_ROOT` 提供的精选插件按与基线
 * Skill 相同的 `.enterprise-seed.json` 摘要语义种子到专家 HOME 插件缓存。
 * 发现链路有两道门槛,每次准备都会重新断言:`~/.zcode/cli/config.json` 合并
 * `plugins.enabledPlugins["<name>@zcode-plugins-official"] = true`(不在编译期
 * 默认启用清单中的插件需要该条目才会加载);`~/.zcode/cli/plugins/installed_plugins.json`
 * 合并安装记录(installPath 留空,解析时回退到我们种子的缓存目录)。两个文件
 * 都承载其它原生状态,因此只做合并且仅在内容变化时写入;专家禁用种子插件
 * 会在下次 runtime 重启时被重新启用,基线集是托管内容。种子绝不移除插件或
 * 外来安装记录(从种子根删除只留下既有副本,移除是 HOME 级操作)。返回本次
 * 写入的 `<name>/<version>` 清单。
 */
export async function seedBaselinePlugins(
  runtimeHome: string,
  pluginSeedRoot: string | undefined,
): Promise<string[]> {
  if (!pluginSeedRoot) return [];
  const { written, units } = await syncSeededTree(
    join(runtimeHome, PLUGIN_CACHE_ROOT),
    pluginSeedRoot,
  );
  const seeded = collectRegistryUnits(units);
  if (seeded.length === 0) return written;
  const names = [...new Set(seeded.map((unit) => unit.name))];
  await enableSeededPlugins(join(runtimeHome, CLI_CONFIG_PATH), names);
  await registerInstalledPlugins(
    join(runtimeHome, PLUGIN_STORAGE_ROOT, INSTALL_REGISTRY_FILE),
    seeded,
  );
  return written;
}
