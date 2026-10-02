import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Input,
  SettingsFormActions,
  SettingsFormTextarea,
  SettingsResourceList,
  SkillResourceRow,
  TooltipProvider,
  ZCodeIntlProvider,
} from "@zcode/ui";
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
 * 行内来源徽标:列表底是 surface,徽标用 background 做下一层,与原生头像的分层一致。
 */
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
 * 列表行与容器直接复用原生展示层(SkillResourceRow + SettingsResourceList),
 * 数据与回调仍全部走网关 createEnterpriseClient,不引入服务 hooks。
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
      const bodyLine = lines.slice(bodyStart).find((line) => line.trim() !== "");
      if (bodyLine) return bodyLine.trim();
    }
    return lines.find((line) => line.trim() !== "")?.trim() ?? skill.name;
  }

  return (
    // 企业设置浮层渲染在全局 ZCodeIntlProvider 之外(main.tsx 只给原生 Root 挂了
    // Provider),而复用的原生 SkillResourceRow 内部调用 useZCodeIntl,缺省会抛错。
    // 这里以无服务形态就近补一层:语言按本地偏好/浏览器语言解析,不引入服务 hook。
    <ZCodeIntlProvider>
      {/* TooltipProvider 同样缺省:原生展示组件可能内嵌 ControlHintTooltip,
          原生只在 Root 内挂载,这里与 IntlProvider 一起就地补齐。 */}
      <TooltipProvider>
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
                    // 导入清单行复用 SkillResourceRow:无开关/删除,来源徽标经
                    // titleExtra 行内展示,导入按钮经 trailingExtra 放行尾。
                    <div data-testid="enterprise-importable-skills">
                      <SettingsResourceList
                        items={filteredImportables}
                        getKey={(item) => `${item.origin}:${item.workspaceId ?? ""}:${item.name}`}
                        renderItem={(item) => (
                          <SkillResourceRow
                            name={item.name}
                            description={item.description || item.name}
                            titleExtra={
                              <>
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
                              </>
                            }
                            trailingExtra={
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
                            }
                          />
                        )}
                      />
                    </div>
                  )}
                </div>
              )
            ) : null}
          </div>
          {/* 租户共享 Skill 目录:组头 + 原生 surface 列表容器,行组件与原生技能分区一致。 */}
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
              // 共享 Skill 目录无启停语义(网关未提供 PATCH),行内只保留删除动作。
              <SettingsResourceList
                items={skills}
                getKey={(skill) => skill.id}
                renderItem={(skill) => (
                  <SkillResourceRow
                    name={skill.name}
                    description={skillSummaryLine(skill)}
                    onDelete={() => deleteSkill(skill)}
                    deleteDisabled={busy}
                  />
                )}
              />
            )}
          </section>
        </section>
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}
