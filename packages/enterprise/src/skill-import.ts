import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { EnterpriseError } from "./types.js";
import { readRegularFile } from "./materialize.js";

/** 原生 Skill 的四个发现根:项目级与用户级各两个目录,`.zcode/skills` 优先。 */
const skillRoots = [".zcode", ".agents"] as const;

export interface ImportableSkillWorkspace {
  id: string;
  name: string;
  workspacePath: string;
}

export interface ImportableSkillView {
  name: string;
  description: string;
  origin: "home" | "workspace";
  workspaceId: string | null;
  workspaceName: string | null;
  alreadyImported: boolean;
  /** 网关基线种子自带(skill-seed 的内置集),导入属冗余复制;UI 据此打「系统预置」标。 */
  preset: boolean;
}

/**
 * 解析 SKILL.md frontmatter 的单行 description。多行/折叠写法不展开,
 * 列表展示足够;截断到 400 字符避免超长描述撑爆选择器。
 */
export function parseSkillDescription(content: string): string {
  if (!content.startsWith("---")) return "";
  const end = content.indexOf("\n---", 3);
  if (end < 0) return "";
  for (const line of content.slice(4, end).split("\n")) {
    const match = /^description:[ \t]*(.+)$/.exec(line);
    if (match) return match[1]!.trim().slice(0, 400);
  }
  return "";
}

interface ScanRoot {
  origin: "home" | "workspace";
  base: string;
  workspace?: ImportableSkillWorkspace;
}

/** 扫描一个根下的两个 Skill 目录;托管 `enterprise-*` 与不可读目录一律跳过。 */
async function scanRoot(
  root: ScanRoot,
  importedNames: ReadonlySet<string>,
  maxBytes: number,
): Promise<ImportableSkillView[]> {
  const found: ImportableSkillView[] = [];
  for (const skillRoot of skillRoots) {
    const directory = join(root.base, skillRoot, "skills");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if ((error as NodeJS.ErrnoException).code === "ENOTDIR") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.startsWith("enterprise-")) continue;
      let content: string;
      try {
        content = await readRegularFile(join(directory, entry.name, "SKILL.md"));
      } catch {
        continue;
      }
      if (Buffer.byteLength(content, "utf8") > maxBytes) continue;
      found.push({
        name: entry.name,
        description: parseSkillDescription(content),
        origin: root.origin,
        workspaceId: root.workspace?.id ?? null,
        workspaceName: root.workspace?.name ?? null,
        alreadyImported: importedNames.has(entry.name),
        preset: false,
      });
    }
  }
  return found;
}

/**
 * 管理员可导入的 Skill 清单:专家 HOME 与租户全部客户 workspace 的四个原生
 * 发现根统一扫描。原生 skill-creator 默认把新 Skill 建在项目级 `.agents/skills`,
 * 只扫 HOME 会漏掉它们——这正是"未找到该 Skill"的来源。
 */
export async function listImportableSkills(input: {
  runtimeHome: string;
  workspaces: ImportableSkillWorkspace[];
  importedNames: ReadonlySet<string>;
  /** 基线种子的名字集;命中且来源为 home 的行标记 preset(工作区副本不算预置)。 */
  presetNames?: ReadonlySet<string>;
  maxBytes?: number;
}): Promise<ImportableSkillView[]> {
  const maxBytes = input.maxBytes ?? 1024 * 1024;
  const roots: ScanRoot[] = [{ origin: "home", base: input.runtimeHome }];
  for (const workspace of input.workspaces)
    roots.push({ origin: "workspace", base: workspace.workspacePath, workspace });
  const views: ImportableSkillView[] = [];
  for (const root of roots)
    views.push(
      ...(await scanRoot(root, input.importedNames, maxBytes)).map((view) => ({
        ...view,
        preset: view.origin === "home" && (input.presetNames ?? new Set()).has(view.name),
      })),
    );
  views.sort((a, b) => a.name.localeCompare(b.name) || a.origin.localeCompare(b.origin));
  return views;
}

/**
 * 按名称+来源解析待导入的 SKILL.md。`.zcode/skills` 优先于 `.agents/skills`,
 * 与原生发现顺序一致;全部未命中时抛 not_found。
 */
export async function readImportableSkill(input: {
  name: string;
  origin: "home" | "workspace";
  workspaceId?: string;
  runtimeHome: string;
  workspaces: ImportableSkillWorkspace[];
  maxBytes?: number;
}): Promise<string> {
  const maxBytes = input.maxBytes ?? 1024 * 1024;
  let base: string;
  if (input.origin === "home") {
    base = input.runtimeHome;
  } else {
    const workspace = input.workspaces.find((item) => item.id === input.workspaceId);
    if (!workspace) throw new EnterpriseError("not_found");
    base = workspace.workspacePath;
  }
  let lastError: EnterpriseError | undefined;
  for (const skillRoot of skillRoots) {
    try {
      const content = await readRegularFile(
        join(base, skillRoot, "skills", input.name, "SKILL.md"),
      );
      if (Buffer.byteLength(content, "utf8") > maxBytes) throw new EnterpriseError("validation");
      return content;
    } catch (error) {
      if (error instanceof EnterpriseError) {
        lastError = error;
        continue;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new EnterpriseError("validation");
    }
  }
  throw lastError ?? new EnterpriseError("not_found");
}
