import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { McpServerConfig } from "@zcode/shared";

const MANAGED_CONTENT_ENV = "ZCODE_ENTERPRISE_MANAGED_CONTENT";

async function writeSkill(root: string, name: string): Promise<string> {
  const skillDir = join(root, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: managed content policy test skill\n---\n\nbody\n`,
    "utf-8",
  );
  return skillDir;
}

function isManagedContentError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === "enterprise.managed_content"
  );
}

test("skill write paths reject enterprise-* names only under the managed-content flag", async () => {
  const home = await mkdtemp(join(tmpdir(), "managed-content-home-"));
  const previousHome = process.env.HOME;
  const previousFlag = process.env[MANAGED_CONTENT_ENV];
  process.env.HOME = home;
  delete process.env[MANAGED_CONTENT_ENV];
  const { createSkillsService } = await import("../src/skills/skillsService.js");
  try {
    // 标记关闭:enterprise-* 目录与普通技能一致,删除/复制不受影响。
    const workspaceOff = await mkdtemp(join(tmpdir(), "managed-content-ws-off-"));
    await writeSkill(join(workspaceOff, ".zcode", "skills"), "enterprise-shared");
    await writeSkill(join(workspaceOff, ".agents", "skills"), "personal-off");
    const serviceOff = createSkillsService();
    const listOff = await serviceOff.list({ workspacePath: workspaceOff });
    const sharedOff = listOff.skills.find((skill) => skill.name === "enterprise-shared");
    const personalOff = listOff.skills.find((skill) => skill.name === "personal-off");
    assert.ok(sharedOff, "flag off should list the enterprise-* skill");
    assert.ok(personalOff, "flag off should list the personal skill");
    await serviceOff.deleteSkill({ workspacePath: workspaceOff, skillId: sharedOff.id });
    const copyOff = await serviceOff.copyToCommon({
      workspacePath: workspaceOff,
      skillId: personalOff.id,
    });
    assert.ok(copyOff.newPath.startsWith(join(workspaceOff, ".zcode", "skills")));

    // 标记开启:enterprise-* 目标名直接拒绝,普通名照常工作。
    process.env[MANAGED_CONTENT_ENV] = "1";
    const workspaceOn = await mkdtemp(join(tmpdir(), "managed-content-ws-on-"));
    await writeSkill(join(workspaceOn, ".zcode", "skills"), "enterprise-managed");
    await writeSkill(join(workspaceOn, ".agents", "skills"), "enterprise-agent");
    await writeSkill(join(workspaceOn, ".agents", "skills"), "personal-on");
    const serviceOn = createSkillsService();
    const listOn = await serviceOn.list({ workspacePath: workspaceOn });
    const byName = new Map(listOn.skills.map((skill) => [skill.name, skill]));
    const managed = byName.get("enterprise-managed");
    const enterpriseAgent = byName.get("enterprise-agent");
    const personalOn = byName.get("personal-on");
    assert.ok(managed && enterpriseAgent && personalOn, "all fixtures should be listed");

    await assert.rejects(
      serviceOn.deleteSkill({ workspacePath: workspaceOn, skillId: managed.id }),
      isManagedContentError,
    );
    assert.equal(managed.scope, "workspace");
    await assert.rejects(
      serviceOn.removeFromCommon({ workspacePath: workspaceOn, skillId: managed.id }),
      isManagedContentError,
    );
    await assert.rejects(
      serviceOn.copyToCommon({ workspacePath: workspaceOn, skillId: enterpriseAgent.id }),
      isManagedContentError,
    );

    const copyOn = await serviceOn.copyToCommon({
      workspacePath: workspaceOn,
      skillId: personalOn.id,
    });
    assert.ok(copyOn.newPath.startsWith(join(workspaceOn, ".zcode", "skills")));
    // 发现层对 SKILL.md 路径做了 realpath(/var → /private/var),断言也要用真实路径比较。
    const workspaceOnReal = await realpath(workspaceOn);
    const listAfterCopy = await serviceOn.list({ workspacePath: workspaceOn });
    const copiedPersonal = listAfterCopy.skills.find(
      (skill) =>
        skill.name === "personal-on" && skill.path.startsWith(join(workspaceOnReal, ".zcode")),
    );
    assert.ok(copiedPersonal, "copied personal skill should be discoverable in the common root");
    await serviceOn.removeFromCommon({ workspacePath: workspaceOn, skillId: copiedPersonal.id });
    await serviceOn.deleteSkill({ workspacePath: workspaceOn, skillId: personalOn.id });

    await rm(workspaceOff, { recursive: true, force: true });
    await rm(workspaceOn, { recursive: true, force: true });
  } finally {
    if (previousFlag === undefined) {
      delete process.env[MANAGED_CONTENT_ENV];
    } else {
      process.env[MANAGED_CONTENT_ENV] = previousFlag;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("mcp config writes reject enterprise-* server names only under the managed-content flag", async () => {
  const home = await mkdtemp(join(tmpdir(), "managed-content-mcp-home-"));
  const previousHome = process.env.HOME;
  const previousFlag = process.env[MANAGED_CONTENT_ENV];
  process.env.HOME = home;
  delete process.env[MANAGED_CONTENT_ENV];
  const { createMcpSyncService } = await import("../src/mcp-sync/mcpSyncService.js");
  const mcp = createMcpSyncService();
  const stdioConfig = { type: "stdio", command: "echo", args: ["mcp"] } satisfies McpServerConfig;
  try {
    // 标记关闭:enterprise-* 名称允许写入(与既有行为一致)。
    await mcp.saveMcpToUserDirectory({
      action: "upsert",
      source: "zcode",
      name: "enterprise-connector",
      config: stdioConfig,
    });

    process.env[MANAGED_CONTENT_ENV] = "1";
    await assert.rejects(
      mcp.saveMcpToUserDirectory({
        action: "upsert",
        source: "zcode",
        name: "enterprise-connector",
        config: stdioConfig,
      }),
      isManagedContentError,
    );
    await assert.rejects(
      mcp.saveMcpToUserDirectory({
        action: "delete",
        source: "zcode",
        name: "enterprise-connector",
      }),
      isManagedContentError,
    );
    await assert.rejects(
      mcp.saveMcpToUserDirectory({
        action: "set-enabled",
        source: "zcode",
        name: "enterprise-connector",
        enabled: false,
      }),
      isManagedContentError,
    );

    // 普通名称在标记开启时仍可新增/启停/删除。
    await mcp.saveMcpToUserDirectory({
      action: "upsert",
      source: "zcode",
      name: "personal-mcp",
      config: stdioConfig,
    });
    await mcp.saveMcpToUserDirectory({
      action: "set-enabled",
      source: "zcode",
      name: "personal-mcp",
      enabled: false,
    });
    await mcp.saveMcpToUserDirectory({ action: "delete", source: "zcode", name: "personal-mcp" });
    const remaining = await mcp.loadMcpFromUserDirectory();
    assert.equal(
      remaining.servers.some((server) => server.name === "personal-mcp"),
      false,
    );
    // 标记开启前的写入保留了 enterprise-connector 条目(拒绝发生在写之前,不回滚存量)。
    assert.equal(
      remaining.servers.some((server) => server.name === "enterprise-connector"),
      true,
    );
  } finally {
    if (previousFlag === undefined) {
      delete process.env[MANAGED_CONTENT_ENV];
    } else {
      process.env[MANAGED_CONTENT_ENV] = previousFlag;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});
