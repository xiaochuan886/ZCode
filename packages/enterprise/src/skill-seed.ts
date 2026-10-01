import { cp, lstat, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const seedRoot = fileURLToPath(new URL("../runtime-seed/skills", import.meta.url));

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
 * 基线 Skill 种子:专家运行时容器里没有插件商店(托管模式拒绝 Z.ai OAuth),
 * skill-creator 等官方插件 Skill 不会自然存在。prepare 时把内置基线集写入
 * 专家 HOME `~/.agents/skills/`——原生标准位置,且发现优先级低于 `.zcode/skills`,
 * 专家仍可用同名副本覆盖。仅目录缺失时写入,绝不覆盖个人层已有内容。
 */
export async function seedBaselineSkills(runtimeHome: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(seedRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const seeded: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const target = join(runtimeHome, ".agents", "skills", entry.name);
    if (await exists(target)) continue;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await cp(join(seedRoot, entry.name), target, { recursive: true });
    seeded.push(entry.name);
  }
  return seeded;
}
