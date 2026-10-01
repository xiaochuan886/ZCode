import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";

const bundledSeedRoot = fileURLToPath(new URL("../runtime-seed/skills", import.meta.url));

const MARKER_NAME = ".enterprise-seed.json";
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

interface SeedMarker {
  version: string;
  seededAt: string;
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

/**
 * SHA-256 over a canonical serialization of a directory tree: relative POSIX
 * paths in sorted order, each path followed by a NUL separator and the raw file
 * bytes. The seed marker is excluded on both the bundled and the seeded side,
 * so writing the marker never changes the digest it describes. Symlinked
 * entries are skipped defensively — a symlink must neither alias foreign
 * content into the digest nor lead the walker outside the tree.
 */
async function digestTree(root: string): Promise<string> {
  const files: string[] = [];
  await collectRegularFiles(root, "", files);
  files.sort();
  const hash = createHash("sha256");
  for (const relative of files) {
    hash.update(`${relative}\0`);
    hash.update(await readFile(join(root, relative)));
  }
  return hash.digest("hex");
}

async function collectRegularFiles(root: string, prefix: string, out: string[]): Promise<void> {
  const entries = await readdir(prefix ? join(root, prefix) : root, { withFileTypes: true });
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!prefix && entry.name === MARKER_NAME) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await collectRegularFiles(root, relative, out);
    else if (entry.isFile()) out.push(relative);
  }
}

async function collectSkillDigests(seedRoot: string): Promise<Map<string, string>> {
  let entries;
  try {
    entries = await readdir(seedRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  const digests = new Map<string, string>();
  for (const name of names) digests.set(name, await digestTree(join(seedRoot, name)));
  return digests;
}

async function readSeedMarker(directory: string): Promise<SeedMarker | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(directory, MARKER_NAME), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return undefined;
    throw error;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.version !== "string" || !DIGEST_PATTERN.test(record.version)) {
      return undefined;
    }
    return {
      version: record.version,
      seededAt: typeof record.seededAt === "string" ? record.seededAt : "",
    };
  } catch {
    // An unparsable or foreign marker means this directory cannot be proven to
    // be our own pristine copy, so it is treated as personally owned.
    return undefined;
  }
}

async function writeSeedMarker(directory: string, version: string): Promise<void> {
  // Field order is fixed by the literal, keeping the marker byte-stable for a
  // given (digest, seededAt) pair.
  const marker: SeedMarker = { version, seededAt: new Date().toISOString() };
  const path = join(directory, MARKER_NAME);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(marker)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Copy a bundled skill into place through a staging directory: the marker is
 * written into the staging copy first, so the visible swap is a single rename.
 * An existing target (the pristine-refresh path) is retired with rollback —
 * if the swap fails, the old copy is restored instead of leaving a gap.
 */
async function seedSkillDirectory(source: string, target: string, version: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const parent = dirname(target);
  const staging = join(parent, `.${basename(target)}.${randomUUID()}.seed-tmp`);
  const retired = join(parent, `.${basename(target)}.${randomUUID()}.seed-old`);
  try {
    await cp(source, staging, { recursive: true });
    await writeSeedMarker(staging, version);
    if (await exists(target)) {
      await rename(target, retired);
      try {
        await rename(staging, target);
      } catch (error) {
        await rename(retired, target).catch(() => undefined);
        throw error;
      }
      await rm(retired, { recursive: true, force: true });
    } else {
      await rename(staging, target);
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncFromDigests(
  runtimeHome: string,
  seedRoot: string,
  digests: ReadonlyMap<string, string>,
): Promise<string[]> {
  const written: string[] = [];
  for (const [name, bundledDigest] of digests) {
    const source = join(seedRoot, name);
    const target = join(runtimeHome, ".agents", "skills", name);
    if (await exists(target)) {
      // A non-directory (file or symlink) is personal territory: never managed.
      if (!(await lstat(target)).isDirectory()) continue;
      const marker = await readSeedMarker(target);
      if (!marker) continue; // personal or marker removed: if-missing semantics
      if (marker.version === bundledDigest) continue; // already current
      // The bundle advanced. Refresh only a pristine copy: the seeded tree is
      // re-hashed BEFORE any removal, and only a tree still matching the
      // digest recorded by our own marker is ever replaced.
      if ((await digestTree(target)) !== marker.version) continue; // expert edits win
      await seedSkillDirectory(source, target, bundledDigest);
      written.push(name);
    } else {
      await seedSkillDirectory(source, target, bundledDigest);
      written.push(name);
    }
  }
  return written;
}

// Version design: the "bundled version" of a skill IS the SHA-256 digest of
// its bundled directory. A hand-maintained number (or a committed version
// file) can drift from the actual bytes after a hotfix copy or a cherry-pick,
// upgrading the wrong trees or silently refusing upgrades; a content digest
// cannot disagree with the content it summarizes. Collapsing version and
// digest into a single marker field removes the second source of truth.
// The bundled tree ships inside the package and cannot change while the
// gateway process runs, so its digests are computed once per process —
// roughly 2 MB of hashing total, then never again.
let bundledDigestCache: Map<string, string> | undefined;

/**
 * 基线 Skill 种子:专家运行时容器里没有插件商店(托管模式拒绝 Z.ai OAuth),
 * skill-creator 等官方插件 Skill 不会自然存在。prepare 时把内置基线集写入
 * 专家 HOME `~/.agents/skills/`——原生标准位置,且发现优先级低于 `.zcode/skills`,
 * 专家仍可用同名副本覆盖。种子时写入 `.enterprise-seed.json` 标记(记录捆绑
 * 内容摘要):捆绑内容升级后,仍与标记摘要一致的干净副本会被替换刷新;被专家
 * 改过或没有标记的个人目录绝不覆盖。
 */
export async function seedBaselineSkills(runtimeHome: string): Promise<string[]> {
  bundledDigestCache ??= await collectSkillDigests(bundledSeedRoot);
  return syncFromDigests(runtimeHome, bundledSeedRoot, bundledDigestCache);
}

/**
 * Same seeding pass with an overridable seed root, so tests can simulate a
 * bundle upgrade from a temporary copy of `runtime-seed/skills`. Unlike the
 * bundled root, an override root may change between calls, so its digests are
 * recomputed on every call instead of using the process cache.
 */
export async function syncBaselineSkills(
  runtimeHome: string,
  seedRoot: string = bundledSeedRoot,
): Promise<string[]> {
  return syncFromDigests(runtimeHome, seedRoot, await collectSkillDigests(seedRoot));
}
