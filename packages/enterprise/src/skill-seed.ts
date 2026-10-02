import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSkillDescription } from "./skill-import.js";
import { digestTree, listChildDirectories, syncSeededUnit } from "./seed-sync.js";

const bundledSeedRoot = fileURLToPath(new URL("../runtime-seed/skills", import.meta.url));

async function collectSkillDigests(seedRoot: string): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  for (const name of await listChildDirectories(seedRoot)) {
    digests.set(name, await digestTree(join(seedRoot, name)));
  }
  return digests;
}

async function syncFromDigests(
  runtimeHome: string,
  seedRoot: string,
  digests: ReadonlyMap<string, string>,
): Promise<string[]> {
  const written: string[] = [];
  for (const [name, bundledDigest] of digests) {
    const seeded = await syncSeededUnit(
      join(seedRoot, name),
      join(runtimeHome, ".agents", "skills", name),
      bundledDigest,
    );
    if (seeded) written.push(name);
  }
  return written;
}

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
 * 改过或没有标记的个人目录绝不覆盖。种子/刷新核心与基线插件种子共用
 * seed-sync.ts。
 */
export interface BaselineSkillView {
  name: string;
  description: string;
}

let baselineListingCache: BaselineSkillView[] | undefined;

/**
 * 系统预置 Skill 清单(只读展示面):直接读捆绑 seed 目录,不落任何业务表。
 * 与 digest 缓存同理,捆绑树在进程内不变,清单只解析一次。
 */
export async function listBaselineSkills(): Promise<BaselineSkillView[]> {
  if (baselineListingCache) return baselineListingCache;
  const listing: BaselineSkillView[] = [];
  for (const name of await listChildDirectories(bundledSeedRoot)) {
    let description = "";
    try {
      description = parseSkillDescription(
        await readFile(join(bundledSeedRoot, name, "SKILL.md"), "utf8"),
      );
    } catch {
      description = "";
    }
    listing.push({ name, description });
  }
  listing.sort((a, b) => a.name.localeCompare(b.name));
  baselineListingCache = listing;
  return listing;
}

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
