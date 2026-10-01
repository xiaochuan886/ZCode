import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { seedBaselineSkills, syncBaselineSkills } from "../src/skill-seed.js";

const bundledSkillCreator = fileURLToPath(
  new URL("../runtime-seed/skills/skill-creator/SKILL.md", import.meta.url),
);

const MARKER_NAME = ".enterprise-seed.json";
const markerPath = (home: string, name: string) =>
  join(home, ".agents", "skills", name, MARKER_NAME);

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
    // 每个种子目录都写入标记:version 是种子时捆绑目录的内容摘要。
    const marker = JSON.parse(await readFile(markerPath(home, name), "utf8")) as {
      version: unknown;
      seededAt: unknown;
    };
    assert.match(String(marker.version), /^[0-9a-f]{64}$/);
    assert.equal(typeof marker.seededAt, "string");
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

test("an unchanged bundle rewrites nothing on the second preparation", async () => {
  const home = await mkdtemp(join(tmpdir(), "enterprise-skill-seed-idempotent-"));
  assert.equal((await seedBaselineSkills(home)).length, 11);
  const content = join(home, ".agents", "skills", "docx", "SKILL.md");
  const before = await stat(content);
  const markerBefore = await readFile(markerPath(home, "docx"), "utf8");
  const second = await seedBaselineSkills(home);
  assert.deepEqual(second, []);
  // 重写必然更新 mtime 与 marker 的 seededAt;两者未变即证明零写入。
  assert.equal((await stat(content)).mtimeMs, before.mtimeMs);
  assert.equal(await readFile(markerPath(home, "docx"), "utf8"), markerBefore);
});

test("a bundle upgrade refreshes pristine copies and leaves diverged or personal ones alone", async () => {
  const seedRoot = await mkdtemp(join(tmpdir(), "enterprise-skill-seed-root-"));
  const home = await mkdtemp(join(tmpdir(), "enterprise-skill-seed-upgrade-"));
  await mkdir(join(seedRoot, "beta", "notes"), { recursive: true });
  await mkdir(join(seedRoot, "alpha"), { recursive: true });
  await mkdir(join(seedRoot, "gamma"), { recursive: true });
  await writeFile(join(seedRoot, "alpha", "SKILL.md"), "alpha v1\n");
  await writeFile(join(seedRoot, "beta", "SKILL.md"), "beta v1\n");
  await writeFile(join(seedRoot, "beta", "notes", "guide.md"), "guide v1\n");
  await writeFile(join(seedRoot, "gamma", "SKILL.md"), "gamma v1\n");
  // 个人目录在种子前已存在且无标记:始终维持 if-missing 语义。
  await mkdir(join(home, ".agents", "skills", "gamma"), { recursive: true });
  await writeFile(join(home, ".agents", "skills", "gamma", "SKILL.md"), "personal gamma\n");

  const first = await syncBaselineSkills(home, seedRoot);
  assert.deepEqual(first, ["alpha", "beta"]);
  const alphaMarkerV1 = await readFile(markerPath(home, "alpha"), "utf8");
  const betaMarkerV1 = JSON.parse(await readFile(markerPath(home, "beta"), "utf8")) as {
    version: string;
  };

  // 专家在种子副本上做了修改(alpha),捆绑内容升级(alpha 与 beta 都换了版本)。
  await writeFile(join(home, ".agents", "skills", "alpha", "SKILL.md"), "alpha v1\nexpert tweak\n");
  await writeFile(join(seedRoot, "alpha", "SKILL.md"), "alpha v2\n");
  await writeFile(join(seedRoot, "beta", "SKILL.md"), "beta v2\n");
  await mkdir(join(seedRoot, "beta", "routes"), { recursive: true });
  await writeFile(join(seedRoot, "beta", "routes", "edit.md"), "edit route v2\n");

  const second = await syncBaselineSkills(home, seedRoot);
  // beta 干净副本被刷新;alpha 已被专家改动,gamma 是个人目录,两者都不动。
  assert.deepEqual(second, ["beta"]);
  assert.equal(
    await readFile(join(home, ".agents", "skills", "beta", "SKILL.md"), "utf8"),
    "beta v2\n",
  );
  assert.equal(
    await readFile(join(home, ".agents", "skills", "beta", "routes", "edit.md"), "utf8"),
    "edit route v2\n",
  );
  const betaMarkerV2 = JSON.parse(await readFile(markerPath(home, "beta"), "utf8")) as {
    version: string;
  };
  assert.notEqual(betaMarkerV2.version, betaMarkerV1.version);
  assert.equal(
    await readFile(join(home, ".agents", "skills", "alpha", "SKILL.md"), "utf8"),
    "alpha v1\nexpert tweak\n",
  );
  assert.equal(await readFile(markerPath(home, "alpha"), "utf8"), alphaMarkerV1);
  assert.equal(
    await readFile(join(home, ".agents", "skills", "gamma", "SKILL.md"), "utf8"),
    "personal gamma\n",
  );
  await assert.rejects(readFile(markerPath(home, "gamma")));

  // 刷新后再次运行:全部跳过,零写入。
  assert.deepEqual(await syncBaselineSkills(home, seedRoot), []);
});
