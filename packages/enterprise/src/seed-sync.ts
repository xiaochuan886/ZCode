import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// Marker-based seed/refresh core shared by the baseline distributions into an
// expert runtime HOME: skills (one-level `<skill>/` layout) and plugins
// (two-level `<plugin>/<version>/` layout). Everything here works on seed
// "units" — a source directory, a target directory and the digest of the
// bundled unit content — so both layouts reduce to enumerating units and
// calling syncSeededUnit.

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
export async function digestTree(root: string): Promise<string> {
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
 * Copy a bundled unit into place through a staging directory: the marker is
 * written into the staging copy first, so the visible swap is a single rename.
 * An existing target (the pristine-refresh path) is retired with rollback —
 * if the swap fails, the old copy is restored instead of leaving a gap.
 */
async function seedDirectory(source: string, target: string, version: string): Promise<void> {
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

/**
 * Seed or refresh one unit with if-missing semantics: a missing target is
 * seeded, an existing target without our marker (personal content) is never
 * touched, and a marked target is refreshed only when the bundle digest
 * advanced AND the current bytes still match the digest recorded by our own
 * marker — expert edits always win. Returns true when the target was written.
 */
export async function syncSeededUnit(
  source: string,
  target: string,
  digest: string,
): Promise<boolean> {
  if (await exists(target)) {
    // A non-directory (file or symlink) is personal territory: never managed.
    if (!(await lstat(target)).isDirectory()) return false;
    const marker = await readSeedMarker(target);
    if (!marker) return false; // personal or marker removed: if-missing semantics
    if (marker.version === digest) return false; // already current
    // The bundle advanced. Refresh only a pristine copy: the seeded tree is
    // re-hashed BEFORE any removal, and only a tree still matching the
    // digest recorded by our own marker is ever replaced.
    if ((await digestTree(target)) !== marker.version) return false; // expert edits win
    await seedDirectory(source, target, digest);
    return true;
  }
  await seedDirectory(source, target, digest);
  return true;
}

// Version design: the "bundled version" of a unit IS the SHA-256 digest of
// its bundled directory. A hand-maintained number (or a committed version
// file) can drift from the actual bytes after a hotfix copy or a cherry-pick,
// upgrading the wrong trees or silently refusing upgrades; a content digest
// cannot disagree with the content it summarizes. Collapsing version and
// digest into a single marker field removes the second source of truth.

/**
 * Enumerate the two-level `<name>/<version>/` units of a seed root, in
 * `<name>` then `<version>` sort order. A missing root yields an empty map —
 * seeding from an absent root is a no-op, not an error.
 */
async function collectSeededUnits(sourceRoot: string): Promise<Map<string, string>> {
  const units = new Map<string, string>();
  const names = await listChildDirectories(sourceRoot);
  for (const name of names) {
    for (const version of await listChildDirectories(join(sourceRoot, name))) {
      units.set(`${name}/${version}`, await digestTree(join(sourceRoot, name, version)));
    }
  }
  return units;
}

/** Real (non-symlink) child directory names in sort order; a missing root is empty. */
export async function listChildDirectories(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

export interface SeededTreeSync {
  /** Relative `<name>/<version>` paths written by this pass, in enumeration order. */
  written: string[];
  /** Full enumeration of the source units, whether written or already current. */
  units: string[];
}

/**
 * Sync every `<name>/<version>/` unit of `sourceRoot` into `targetRoot` with
 * the marker-based if-missing/refresh semantics. Returns the written paths and
 * the full unit enumeration, so callers that must re-assert per-unit state
 * (config entries, install-registry records) do not need a second digest pass.
 * Unlike the bundled skill root, a caller-supplied root may change between
 * calls, so digests are recomputed on every call.
 */
export async function syncSeededTree(
  targetRoot: string,
  sourceRoot: string,
): Promise<SeededTreeSync> {
  const written: string[] = [];
  const units: string[] = [];
  for (const [relative, digest] of await collectSeededUnits(sourceRoot)) {
    units.push(relative);
    if (await syncSeededUnit(join(sourceRoot, relative), join(targetRoot, relative), digest)) {
      written.push(relative);
    }
  }
  return { written, units };
}
