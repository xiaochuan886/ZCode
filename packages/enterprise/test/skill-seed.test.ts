import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { seedBaselineSkills } from "../src/skill-seed.js";

const bundledSkillCreator = fileURLToPath(
  new URL("../runtime-seed/skills/skill-creator/SKILL.md", import.meta.url),
);

test("baseline skills seed into the expert home agents directory when missing", async () => {
  const home = await mkdtemp(join(tmpdir(), "enterprise-skill-seed-"));
  const seeded = await seedBaselineSkills(home);
  // 基线集会随 runtime-seed/skills 增减:断言关键成员存在且全部落盘,不钉死完整清单。
  assert.ok(seeded.includes("skill-creator"));
  assert.ok(seeded.includes("zcode-configuration-guide"));
  assert.ok(seeded.includes("docx"));
  assert.ok(seeded.includes("pptx"));
  assert.equal(seeded.length, 11);
  for (const name of seeded) {
    await readFile(join(home, ".agents", "skills", name, "SKILL.md"), "utf8");
  }
  assert.equal(
    await readFile(join(home, ".agents", "skills", "skill-creator", "SKILL.md"), "utf8"),
    await readFile(bundledSkillCreator, "utf8"),
  );
});

test("baseline seeding never overwrites an existing personal skill directory", async () => {
  const home = await mkdtemp(join(tmpdir(), "enterprise-skill-seed-existing-"));
  const target = join(home, ".agents", "skills", "skill-creator", "SKILL.md");
  await mkdir(join(home, ".agents", "skills", "skill-creator"), { recursive: true });
  await writeFile(
    target,
    "---\nname: skill-creator\ndescription: expert override\n---\n# Own copy\n",
  );
  const seeded = await seedBaselineSkills(home);
  // 其它基线 Skill 仍会被种子;断言只关心已存在的 skill-creator 不被覆盖。
  assert.equal(seeded.includes("skill-creator"), false);
  assert.match(await readFile(target, "utf8"), /Own copy/);
});
