import { useCallback, useEffect, useState } from "react";
import { Trash2, WandSparkles } from "lucide-react";
import { Button, Input, SettingsFormActions, SettingsFormTextarea } from "@zcode/ui";
import {
  createEnterpriseClient,
  EnterpriseApiError,
  type ImportableTenantSkillView,
  type TenantSkillView,
} from "./api.js";
import { zh } from "./presentation.js";
import { skillTabStrings } from "./skill-tab-strings.js";

const api = createEnterpriseClient();

/**
 * 镜像原生 SkillsSection 的列表行骨架(packages/ui/src/settings/SkillsSection.tsx
 * 的 renderSkillRow + SettingsResourceList):surface 圆角容器、border/50 分隔线、
 * 「头像 | 名称/描述截断 | 行尾操作」三列网格与 hover 反馈。原生组件耦合工作区
 * 服务上下文不可直接复用,这里只借无状态的原生原语(Button/Input 等复刻视觉)。
 */
const SKILL_ROW_CLASS_NAME =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-hover";
const SKILL_AVATAR_CLASS_NAME =
  "flex size-9 shrink-0 items-center justify-center rounded-xl bg-background text-foreground-subtle";
/** 行内来源徽标:列表底是 surface,徽标用 background 做下一层,与原生头像的分层一致。 */
const SKILL_BADGE_CLASS_NAME =
  "rounded-full border border-border bg-background px-2 py-0.5 text-ui-xs text-foreground-subtle";
/** 对齐原生 SettingsResourceGroupHeader 的组头样式:标题 + 计数。 */
const SKILL_GROUP_HEADER_CLASS_NAME =
  "flex h-7 items-center gap-1.5 text-ui-base font-medium text-foreground";
/** 对齐原生 PluginInstallEmptyState 的虚线空态容器。 */
const SKILL_EMPTY_STATE_CLASS_NAME =
  "rounded-xl border border-dashed border-border bg-transparent px-4 py-10 text-center";

/**
 * 共享 Skill tab(仅管理员):手工创建 + 选择器导入。原生 skill-creator 新建的
 * Skill 默认落在项目级(客户工作区),所以可导入清单覆盖个人运行时与全部客户
 * 工作区,以名称+描述+来源列表呈现(对齐 composer Skill 选择器的形态)。
 */
export function EnterpriseSkillSettings({
  t,
  tenantId,
  csrfToken,
}: {
  t: typeof zh;
  tenantId: string;
  csrfToken: string | null;
}) {
  // EnterpriseApp 以 presentation 的 zh/en 对象整体下发 t,用身份比较挑选本 tab
  // 新增文案的语言,避免向 Shell 层新增 locale 插槽。
  const s = t === zh ? skillTabStrings.zh : skillTabStrings.en;
  const [skills, setSkills] = useState<TenantSkillView[]>([]);
  const [skillsFailed, setSkillsFailed] = useState(false);
  const [skillName, setSkillName] = useState("");
  const [skillContent, setSkillContent] = useState("");
  const [importables, setImportables] = useState<ImportableTenantSkillView[] | null>(null);
  const [importFilter, setImportFilter] = useState("");
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reloadSkills = useCallback(() => {
    if (!tenantId) return;
    api
      .tenantSkills(tenantId)
      .then((items) => {
        setSkills(items);
        setSkillsFailed(false);
      })
      .catch(() => setSkillsFailed(true));
  }, [tenantId]);

  useEffect(() => {
    reloadSkills();
  }, [reloadSkills]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function createSkill() {
    if (!tenantId || !skillName.trim() || !skillContent.trim()) return;
    void run(async () => {
      await api.createTenantSkill(tenantId, { name: skillName, content: skillContent }, csrfToken);
      setSkillName("");
      setSkillContent("");
      reloadSkills();
    });
  }

  function deleteSkill(skill: TenantSkillView) {
    if (!tenantId) return;
    void run(async () => {
      await api.deleteTenantSkill(tenantId, skill.id, csrfToken);
      reloadSkills();
    });
  }

  function loadImportables() {
    if (!tenantId) return;
    void run(async () => {
      const items = await api.importableSkills(tenantId);
      setImportables(items);
      setImportNotice(null);
    });
  }

  function importSkill(item: ImportableTenantSkillView) {
    if (!tenantId) return;
    void run(async () => {
      try {
        await api.importTenantSkill(
          tenantId,
          {
            name: item.name,
            origin: item.origin,
            workspaceId: item.workspaceId,
          },
          csrfToken,
        );
      } catch (cause) {
        // 源目录在加载后被删除等场景返回 404,给内联提示而不是顶部错误横幅。
        if (cause instanceof EnterpriseApiError && cause.status === 404) {
          setImportNotice(t.importSkillNotFound);
          return;
        }
        throw cause;
      }
      setImportNotice(null);
      reloadSkills();
      // 刷新清单以翻转该项的"已导入"标记。
      const items = await api.importableSkills(tenantId);
      setImportables(items);
    });
  }

  const filteredImportables = (importables ?? []).filter((item) =>
    item.name.toLowerCase().includes(importFilter.trim().toLowerCase()),
  );

  /**
   * 共享 Skill 目录的描述行:优先取 frontmatter 里的 description,否则取正文首个非空行。
   * 只认首个非空行会把 frontmatter 分隔符 "---" 当描述展示,故先剥掉 frontmatter 块。
   */
  function skillSummaryLine(skill: TenantSkillView): string {
    const lines = skill.content.split("\n");
    const firstIndex = lines.findIndex((line) => line.trim() !== "");
    if (firstIndex >= 0 && lines[firstIndex]!.trim() === "---") {
      const frontmatterDescription = lines
        .slice(firstIndex + 1)
        .find((line) => line.trim().startsWith("description:"));
      if (frontmatterDescription) {
        const value = frontmatterDescription.split(":").slice(1).join(":").trim();
        if (value) return value;
      }
      const closing = lines.indexOf("---", firstIndex + 1);
      const bodyStart = (closing >= 0 ? closing : firstIndex) + 1;
      const bodyLine = lines
        .slice(bodyStart)
        .find((line) => line.trim() !== "");
      if (bodyLine) return bodyLine.trim();
    }
    return lines.find((line) => line.trim() !== "")?.trim() ?? skill.name;
  }

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-ui-xl font-medium">{t.sharedSkills}</h1>
      <p className="max-w-2xl text-ui-sm text-foreground-subtle">{t.sharedSkillsHint}</p>
      {skillsFailed ? (
        <p className="text-ui-sm text-destructive" role="alert">
          {t.sharedSkillFailed}
        </p>
      ) : null}
      {error ? (
        <p className="text-ui-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {/* 手工创建表单:自绘 input/textarea 换成原生 Input/SettingsFormTextarea,
          提交条件与回调语义保持不变。 */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
        <label className="flex flex-col gap-1 text-ui-sm">
          {t.sharedSkillName}
          <Input
            value={skillName}
            placeholder={t.sharedSkillPlaceholder}
            onChange={(event) => setSkillName(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-ui-sm">
          {t.sharedSkillContent}
          <SettingsFormTextarea
            className="min-h-32 font-mono text-ui-sm"
            value={skillContent}
            placeholder={t.sharedSkillContentPlaceholder}
            onChange={(event) => setSkillContent(event.target.value)}
          />
        </label>
        <SettingsFormActions>
          <Button
            type="button"
            disabled={busy || !skillName.trim() || !skillContent.trim()}
            onClick={createSkill}
          >
            {t.createSharedSkill}
          </Button>
        </SettingsFormActions>
      </div>
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-ui-sm font-medium">{t.importSkillTitle}</p>
            <p className="mt-1 text-ui-xs text-foreground-subtle">{t.importSkillHint}</p>
          </div>
          <Button type="button" variant="outline" disabled={busy} onClick={loadImportables}>
            {t.importSkillPick}
          </Button>
        </div>
        {importNotice ? (
          <p className="text-ui-sm text-destructive" role="alert">
            {importNotice}
          </p>
        ) : null}
        {importables ? (
          importables.length === 0 ? (
            <p className="text-ui-sm text-foreground-subtle">{t.importSkillEmpty}</p>
          ) : (
            <div className="flex flex-col gap-2">
              <Input
                value={importFilter}
                placeholder={t.importSkillFilterPlaceholder}
                onChange={(event) => setImportFilter(event.target.value)}
              />
              {filteredImportables.length === 0 ? (
                // 过滤无结果:对齐原生搜索空态,但清单本身非空,不用 importSkillEmpty。
                <p
                  className={`${SKILL_EMPTY_STATE_CLASS_NAME} text-ui-base text-foreground-subtle`}
                >
                  {s.importSkillSearchEmpty}
                </p>
              ) : (
                <ul
                  className="overflow-hidden rounded-xl bg-surface"
                  data-testid="enterprise-importable-skills"
                >
                  {filteredImportables.map((item, index) => (
                    <li key={`${item.origin}:${item.workspaceId ?? ""}:${item.name}`}>
                      {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
                      <div className={SKILL_ROW_CLASS_NAME}>
                        <div className={SKILL_AVATAR_CLASS_NAME} aria-hidden="true">
                          <WandSparkles className="size-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="truncate text-ui-base font-medium text-foreground">
                              {item.name}
                            </span>
                            <span className={SKILL_BADGE_CLASS_NAME}>
                              {t.importSkillOriginHome}
                            </span>
                            {item.origin === "workspace" ? (
                              <span className={SKILL_BADGE_CLASS_NAME}>
                                {t.importSkillOriginWorkspace}
                                {item.workspaceName ? ` · ${item.workspaceName}` : ""}
                              </span>
                            ) : null}
                            {item.alreadyImported ? (
                              <span className={SKILL_BADGE_CLASS_NAME}>
                                {t.importSkillAlreadyImported}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-0.5 truncate text-ui-sm text-foreground-subtle">
                            {item.description || item.name}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy || item.alreadyImported}
                            onClick={() => importSkill(item)}
                          >
                            {item.alreadyImported
                              ? t.importSkillAlreadyImported
                              : t.importSkillAction}
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        ) : null}
      </div>
      {/* 租户共享 Skill 目录:组头 + surface 列表,镜像原生技能分区的层级与密度。 */}
      <section className="space-y-4" data-testid="enterprise-settings-skills">
        <h3 className={SKILL_GROUP_HEADER_CLASS_NAME}>
          {s.sharedSkillListTitle}
          <span className="text-ui-sm font-normal text-foreground-subtle">{skills.length}</span>
        </h3>
        {skills.length === 0 ? (
          <div
            className={`${SKILL_EMPTY_STATE_CLASS_NAME} flex flex-col items-center justify-center gap-3`}
          >
            <div className="space-y-1">
              <div className="text-ui-base font-medium text-foreground">{t.noSharedSkill}</div>
              <div className="text-ui-sm text-foreground-subtle">{s.sharedSkillEmptyHint}</div>
            </div>
          </div>
        ) : (
          <ul className="overflow-hidden rounded-xl bg-surface">
            {skills.map((skill, index) => (
              <li key={skill.id}>
                {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
                <div className={SKILL_ROW_CLASS_NAME}>
                  <div className={SKILL_AVATAR_CLASS_NAME} aria-hidden="true">
                    <WandSparkles className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate text-ui-base font-medium text-foreground">
                        {skill.name}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-ui-sm text-foreground-subtle">
                      {skillSummaryLine(skill)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {/* 删除沿用原生行尾 ghost 图标按钮(悬停转 destructive)。 */}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-foreground-subtle hover:bg-destructive/10 hover:text-destructive"
                      aria-label={t.deleteSharedSkill}
                      title={t.deleteSharedSkill}
                      disabled={busy}
                      onClick={() => deleteSkill(skill)}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
