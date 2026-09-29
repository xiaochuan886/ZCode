import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareCaseWorkspace } from "../src/materialize.js";

const context = {
  caseId: "case-a",
  title: "Login failure",
  category: "support",
  serviceObject: { name: "Customer A", type: "application", metadata: { version: "1.0" } },
  contextSnapshot: { environment: "production" },
};

test("materializes case snapshot as native workspace instructions", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "zcode-case-"));
  await prepareCaseWorkspace({ workspacePath, caseContext: context });
  const instructions = await readFile(join(workspacePath, "AGENTS.md"), "utf8");
  const caseFile = await readFile(join(workspacePath, "CASE_CONTEXT.md"), "utf8");
  assert.match(instructions, /CASE_CONTEXT\.md/);
  assert.match(caseFile, /Customer A/);
  assert.match(caseFile, /production/);
  assert.match(caseFile, /case-a/);
});

test("syncs only supplied enterprise skills and preserves native skills", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "zcode-case-"));
  const nativeSkill = join(workspacePath, ".zcode", "skills", "native");
  await mkdir(nativeSkill, { recursive: true });
  await writeFile(join(nativeSkill, "SKILL.md"), "native");
  const content = "# Shared skill\n";
  await prepareCaseWorkspace({
    workspacePath,
    caseContext: context,
    sharedSkills: [
      {
        id: "skill-a",
        name: "Shared",
        content,
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ],
  });
  assert.equal(await readFile(join(nativeSkill, "SKILL.md"), "utf8"), "native");
  assert.equal(
    await readFile(
      join(workspacePath, ".zcode", "skills", "enterprise-skill-a", "SKILL.md"),
      "utf8",
    ),
    content,
  );
  await prepareCaseWorkspace({ workspacePath, caseContext: context, sharedSkills: [] });
  assert.deepEqual((await readdir(join(workspacePath, ".zcode", "skills"))).sort(), ["native"]);
});

test("rejects invalid skill path and hash", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "zcode-case-"));
  await assert.rejects(
    prepareCaseWorkspace({
      workspacePath,
      caseContext: context,
      sharedSkills: [{ id: "../escape", name: "Bad", content: "x" }],
    }),
  );
  await assert.rejects(
    prepareCaseWorkspace({
      workspacePath,
      caseContext: context,
      sharedSkills: [{ id: "safe", name: "Bad", content: "x", sha256: "bad" }],
    }),
  );
});

test("does not write a shared Skill through an existing symlink", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "zcode-case-"));
  const outside = await mkdtemp(join(tmpdir(), "zcode-outside-"));
  await mkdir(join(workspacePath, ".zcode", "skills"), { recursive: true });
  await symlink(outside, join(workspacePath, ".zcode", "skills", "enterprise-skill-a"));
  await assert.rejects(
    prepareCaseWorkspace({
      workspacePath,
      caseContext: context,
      sharedSkills: [{ id: "skill-a", name: "Shared", content: "evil" }],
    }),
  );
  assert.deepEqual(await readdir(outside), []);
});

test("merges MCP bindings without exposing stale enterprise endpoints", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "zcode-case-"));
  const configPath = join(workspacePath, ".zcode", "config.json");
  await mkdir(join(workspacePath, ".zcode"), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      model: "native",
      mcp: {
        servers: {
          native: { url: "https://native.example" },
          "enterprise-old": { url: "https://old.example" },
        },
      },
    }),
  );
  await prepareCaseWorkspace({
    workspacePath,
    caseContext: context,
    mcpServers: { new: { url: "https://new.example" } },
  });
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.model, "native");
  assert.equal(config.mcp.servers.native.url, "https://native.example");
  assert.equal(config.mcp.servers["enterprise-new"].url, "https://new.example");
  assert.equal(config.mcp.servers["enterprise-old"], undefined);
});
