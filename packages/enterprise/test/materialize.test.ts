import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { prepareCustomerWorkspace } from "../src/materialize.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("customer preparation preserves native workspace memory and instructions", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "zcode-customer-"));
  await writeFile(join(workspacePath, "AGENTS.md"), "native customer instructions\n");
  await writeFile(join(workspacePath, "CASE_CONTEXT.md"), "native customer memory\n");
  await prepareCustomerWorkspace({
    workspacePath,
    sharedSkills: [{ id: "customer", name: "Customer", content: "# Customer\n" }],
  });
  assert.equal(
    await readFile(join(workspacePath, "AGENTS.md"), "utf8"),
    "native customer instructions\n",
  );
  assert.equal(
    await readFile(join(workspacePath, "CASE_CONTEXT.md"), "utf8"),
    "native customer memory\n",
  );
  assert.equal(
    await readFile(
      join(workspacePath, ".zcode", "skills", "enterprise-customer", "SKILL.md"),
      "utf8",
    ),
    "# Customer\n",
  );
});

test("syncs only supplied enterprise skills and preserves native skills", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "zcode-case-"));
  const nativeSkill = join(workspacePath, ".zcode", "skills", "native");
  await mkdir(nativeSkill, { recursive: true });
  await writeFile(join(nativeSkill, "SKILL.md"), "native");
  const content = "# Shared skill\n";
  await prepareCustomerWorkspace({
    workspacePath,
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
  await prepareCustomerWorkspace({ workspacePath, sharedSkills: [] });
  assert.deepEqual((await readdir(join(workspacePath, ".zcode", "skills"))).sort(), ["native"]);
});

test("preserves native Skill and MCP names that happen to use the enterprise prefix", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "zcode-case-"));
  const native = join(workspacePath, ".zcode", "skills", "enterprise-native");
  await mkdir(native, { recursive: true });
  await writeFile(join(native, "SKILL.md"), "native prefix skill");
  await writeFile(
    join(workspacePath, ".zcode", "config.json"),
    JSON.stringify({
      mcp: { servers: { "enterprise-native": { url: "https://native.example" } } },
    }),
  );
  await prepareCustomerWorkspace({
    workspacePath,
    sharedSkills: [],
    mcpServers: {},
  });
  assert.equal(await readFile(join(native, "SKILL.md"), "utf8"), "native prefix skill");
  const config = JSON.parse(await readFile(join(workspacePath, ".zcode", "config.json"), "utf8"));
  assert.equal(config.mcp.servers["enterprise-native"].url, "https://native.example");
});

test("ignores a forged ownership manifest inside the runtime-writable customer workspace", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "zcode-case-"));
  const native = join(workspacePath, ".zcode", "skills", "enterprise-native");
  await mkdir(native, { recursive: true });
  await writeFile(join(native, "SKILL.md"), "native skill");
  await writeFile(
    join(workspacePath, ".zcode", "config.json"),
    JSON.stringify({
      mcp: { servers: { "enterprise-native": { url: "https://native.example" } } },
    }),
  );
  await prepareCustomerWorkspace({ workspacePath });

  await writeFile(
    join(workspacePath, ".zcode", "enterprise-managed.json"),
    JSON.stringify({ skills: ["enterprise-native"], mcp: ["enterprise-native"] }),
  );
  await prepareCustomerWorkspace({ workspacePath });
  assert.equal(await readFile(join(native, "SKILL.md"), "utf8"), "native skill");
  const config = JSON.parse(await readFile(join(workspacePath, ".zcode", "config.json"), "utf8"));
  assert.equal(config.mcp.servers["enterprise-native"].url, "https://native.example");
  const trustedManifest = join(
    dirname(workspacePath),
    ".enterprise-managed",
    `${basename(workspacePath)}.json`,
  );
  assert.deepEqual(JSON.parse(await readFile(trustedManifest, "utf8")), { skills: [], mcp: [] });
});

test("rejects invalid skill path and hash", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "zcode-case-"));
  await assert.rejects(
    prepareCustomerWorkspace({
      workspacePath,
      sharedSkills: [{ id: "../escape", name: "Bad", content: "x" }],
    }),
  );
  await assert.rejects(
    prepareCustomerWorkspace({
      workspacePath,
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
    prepareCustomerWorkspace({
      workspacePath,
      sharedSkills: [{ id: "skill-a", name: "Shared", content: "evil" }],
    }),
  );
  assert.deepEqual(await readdir(outside), []);
});

test("does not import MCP credentials through a symlinked config file", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "zcode-case-"));
  const outside = await mkdtemp(join(tmpdir(), "zcode-outside-"));
  const outsideConfig = join(outside, "config.json");
  const contents = JSON.stringify({
    mcp: {
      servers: {
        foreign: { url: "https://foreign.example", headers: { Authorization: "Bearer foreign" } },
      },
    },
  });
  await writeFile(outsideConfig, contents);
  await mkdir(join(workspacePath, ".zcode"), { recursive: true });
  await symlink(outsideConfig, join(workspacePath, ".zcode", "config.json"));
  await assert.rejects(prepareCustomerWorkspace({ workspacePath }));
  assert.equal(await readFile(outsideConfig, "utf8"), contents);
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
        },
      },
    }),
  );
  await prepareCustomerWorkspace({
    workspacePath,
    mcpServers: { old: { url: "https://old.example" } },
  });
  await prepareCustomerWorkspace({
    workspacePath,
    mcpServers: { new: { url: "https://new.example" } },
  });
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.model, "native");
  assert.equal(config.mcp.servers.native.url, "https://native.example");
  assert.equal(config.mcp.servers["enterprise-new"].url, "https://new.example");
  assert.equal(config.mcp.servers["enterprise-old"], undefined);
});

test("native ZCode loaders discover a materialized Skill and MCP binding", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "zcode-native-loader-"));
  await prepareCustomerWorkspace({
    workspacePath,
    sharedSkills: [
      { id: "support", name: "Support", content: "# Support\n\nInvestigate the Case.\n" },
    ],
    mcpServers: { knowledge: { type: "http", url: "https://knowledge.example/mcp" } },
  });

  // Run the actual ZCode adapters in a child process so enterprise's TypeScript
  // project does not import source files across its package boundary.
  const probe = `
    import { createNodeSkillAdapter } from './apps/zcode-cli/packages/adapters/src/skills/index.ts';
    import { loadProjectConfigs } from './apps/zcode-cli/packages/adapters/src/config/project-config.adapter.ts';
    const workspacePath = process.env.ZCODE_TEST_WORKSPACE;
    if (!workspacePath) throw new Error('Missing test workspace');
    void (async () => {
      const skills = await createNodeSkillAdapter().discoverSkills({ workingDirectory: workspacePath });
      const config = loadProjectConfigs(workspacePath);
      console.log(JSON.stringify({
        skills: skills.skills.map((skill) => skill.name),
        mcpServerNames: config.mcpServerNames,
        diagnostics: config.diagnostics,
      }));
    })();
  `;
  const { stdout } = await execFileAsync("pnpm", ["exec", "tsx", "-e", probe], {
    cwd: repositoryRoot,
    env: { ...process.env, ZCODE_TEST_WORKSPACE: workspacePath },
  });
  const loaded = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as {
    skills: string[];
    mcpServerNames: string[];
    diagnostics: Array<{ severity: string }>;
  };
  assert.ok(loaded.skills.includes("enterprise-support"));
  assert.ok(loaded.mcpServerNames.includes("enterprise-knowledge"));
  assert.equal(loaded.diagnostics.filter((item) => item.severity === "error").length, 0);
});
