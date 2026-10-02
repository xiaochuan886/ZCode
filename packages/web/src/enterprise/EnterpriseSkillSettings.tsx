import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Import, Plus } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  PluginInstallEmptyState,
  SettingsFormTextarea,
  SettingsResourceGroupHeader,
  SettingsResourceHeaderActions,
  SettingsResourceList,
  SkillResourceRow,
  TooltipProvider,
  ZCodeIntlProvider,
} from "@zcode/ui";
import {
  createEnterpriseClient,
  EnterpriseApiError,
  type ImportableTenantSkillView,
  type PresetSkillView,
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

/**
 * 共享 Skill tab(仅管理员),结构与原生 SkillsSection 同构:
 * 组头(SettingsResourceGroupHeader + 头部动作按钮) → 列表(SettingsResourceList +
 * SkillResourceRow,行点击开详情弹窗) → 空态(PluginInstallEmptyState + 大按钮);
 * 手工创建与导入不再常驻表单卡片,改由头部动作打开弹窗(原生动线)。
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
  const [presets, setPresets] = useState<PresetSkillView[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [skillName, setSkillName] = useState("");
  const [skillContent, setSkillContent] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importables, setImportables] = useState<ImportableTenantSkillView[] | null>(null);
  const [importFilter, setImportFilter] = useState("");
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [presetExpanded, setPresetExpanded] = useState(false);
  const [detailSkill, setDetailSkill] = useState<TenantSkillView | null>(null);
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
    // 系统预置清单只随网关升级变化,失败静默为空(只读展示面,不值得报错横幅)。
    if (tenantId)
      api
        .presetSkills(tenantId)
        .then(setPresets)
        .catch(() => setPresets([]));
  }, [reloadSkills, tenantId]);

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
      setCreateOpen(false);
      reloadSkills();
    });
  }

  function deleteSkill(skill: TenantSkillView) {
    if (!tenantId) return;
    void run(async () => {
      await api.deleteTenantSkill(tenantId, skill.id, csrfToken);
      // 删除正在查看的条目时同步关掉详情弹窗,避免悬空引用。
      setDetailSkill((current) => (current?.id === skill.id ? null : current));
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

  function openImportDialog() {
    setImportOpen(true);
    loadImportables();
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
  // 系统预置行与普通行分流:预置每个专家自带,导入属冗余,默认收起;过滤时自动展开。
  const filteredPresetImportables = filteredImportables.filter((item) => item.preset);
  const filteredNormalImportables = filteredImportables.filter((item) => !item.preset);
  const presetSectionVisible = presetExpanded || importFilter.trim().length > 0;

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
    // 企业设置浮层渲染在全局 ZCodeIntlProvider 之外,原生展示组件(组头动作按钮等)
    // 内部调用 useZCodeIntl/ControlHintTooltip,缺省会抛错;就近补挂语言与 tooltip。
    <ZCodeIntlProvider>
      <TooltipProvider>
        <section className="flex flex-col gap-4" data-testid="enterprise-settings-skills">
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
          <SettingsResourceGroupHeader
            title={s.sharedSkillListTitle}
            count={skills.length}
            actions={
              <SettingsResourceHeaderActions
                onNew={() => setCreateOpen(true)}
                onImport={openImportDialog}
                onRefresh={reloadSkills}
                newDisabled={busy}
                importDisabled={busy}
              />
            }
          />
          {skills.length === 0 && !skillsFailed ? (
            <PluginInstallEmptyState
              title={t.noSharedSkill}
              description={s.sharedSkillEmptyHint}
              actions={
                <>
                  <Button
                    type="button"
                    variant="default"
                    size="lg"
                    onClick={() => setCreateOpen(true)}
                  >
                    <Plus data-icon="inline-start" aria-hidden="true" />
                    {s.newSkillAction}
                  </Button>
                  <Button type="button" variant="outline" size="lg" onClick={openImportDialog}>
                    <Import data-icon="inline-start" aria-hidden="true" />
                    {s.importSkillAction}
                  </Button>
                </>
              }
            />
          ) : (
            // 共享 Skill 目录无启停语义(网关未提供 PATCH),行内只保留删除动作。
            <SettingsResourceList
              items={skills}
              getKey={(skill) => skill.id}
              renderItem={(skill) => (
                <SkillResourceRow
                  name={skill.name}
                  description={skillSummaryLine(skill)}
                  onOpen={() => setDetailSkill(skill)}
                  onDelete={() => deleteSkill(skill)}
                  deleteDisabled={busy}
                />
              )}
            />
          )}

          {/* 系统预置 Skill:网关基线种子,每个专家运行时自带,与租户共享是两条通道。
              只读展示(无增删/导入动作),让管理员分清"自带"与"我共享的"。 */}
          {presets.length > 0 ? (
            <section className="flex flex-col gap-4" data-testid="enterprise-preset-skills">
              <SettingsResourceGroupHeader title={s.presetGroupTitle} count={presets.length} />
              <p className="text-ui-xs text-foreground-subtle">{s.presetGroupHint}</p>
              <SettingsResourceList
                items={presets}
                getKey={(preset) => preset.name}
                renderItem={(preset) => (
                  <SkillResourceRow name={preset.name} description={preset.description} />
                )}
              />
            </section>
          ) : null}

          {/* 手工创建:常驻表单改为弹窗(原生动线),字段与提交条件不变。
              限高 + 内容区滚动(与详情弹窗同构),长文本不会把弹窗撑出视口。 */}
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogContent className="flex max-h-[min(80vh,640px)] max-w-lg flex-col overflow-hidden p-0">
              <DialogHeader className="border-b border-popover-border px-4 pt-4 pb-3">
                <DialogTitle>{s.createDialogTitle}</DialogTitle>
              </DialogHeader>
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-4">
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
              </div>
              <DialogFooter className="border-t border-popover-border px-4 py-3">
                <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                  {s.cancelAction}
                </Button>
                <Button
                  type="button"
                  disabled={busy || !skillName.trim() || !skillContent.trim()}
                  onClick={createSkill}
                >
                  {t.createSharedSkill}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* 导入选择器:覆盖个人运行时与全部客户工作区,按名称过滤后逐条导入。
              清单可能很长:限高 + 中部滚动,头部(标题/过滤框)与底部按钮固定。 */}
          <Dialog
            open={importOpen}
            onOpenChange={(open) => {
              setImportOpen(open);
              if (!open) setImportNotice(null);
            }}
          >
            <DialogContent className="flex max-h-[min(80vh,640px)] max-w-xl flex-col overflow-hidden p-0">
              <DialogHeader className="border-b border-popover-border px-4 pt-4 pb-3">
                <DialogTitle>{s.importDialogTitle}</DialogTitle>
              </DialogHeader>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-4 py-4">
                <p className="text-ui-sm text-foreground-subtle">{t.importSkillHint}</p>
                {importNotice ? (
                  <p className="text-ui-sm text-destructive" role="alert">
                    {importNotice}
                  </p>
                ) : null}
                {importables === null ? (
                  <p className="text-ui-sm text-foreground-subtle">{t.importSkillPick}</p>
                ) : importables.length === 0 ? (
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
                      <p className="py-6 text-center text-ui-base text-foreground-subtle">
                        {s.importSkillSearchEmpty}
                      </p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {filteredNormalImportables.length > 0 ? (
                          <SettingsResourceList
                            items={filteredNormalImportables}
                            getKey={(item) =>
                              `${item.origin}:${item.workspaceId ?? ""}:${item.name}`
                            }
                            renderItem={(item) => (
                              <SkillResourceRow
                                name={item.name}
                                description={item.description}
                                titleExtra={
                                  <>
                                    <span className={SKILL_BADGE_CLASS_NAME}>
                                      {item.origin === "home"
                                        ? t.importSkillOriginHome
                                        : t.importSkillOriginWorkspace}
                                    </span>
                                    {item.origin === "workspace" && item.workspaceName ? (
                                      <span className={SKILL_BADGE_CLASS_NAME}>
                                        {item.workspaceName}
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
                        ) : null}
                        {filteredPresetImportables.length > 0 ? (
                          <div className="flex flex-col gap-2">
                            <button
                              type="button"
                              className="flex items-center gap-1 self-start text-ui-sm text-foreground-subtle hover:text-foreground"
                              aria-expanded={presetSectionVisible}
                              onClick={() => setPresetExpanded((prev) => !prev)}
                            >
                              {presetSectionVisible ? (
                                <ChevronDown className="size-3.5" aria-hidden="true" />
                              ) : (
                                <ChevronRight className="size-3.5" aria-hidden="true" />
                              )}
                              {s.presetImportSectionTitle}
                              <span className="text-ui-sm font-normal text-foreground-subtle">
                                {filteredPresetImportables.length}
                              </span>
                            </button>
                            {presetSectionVisible ? (
                              <SettingsResourceList
                                items={filteredPresetImportables}
                                getKey={(item) =>
                                  `${item.origin}:${item.workspaceId ?? ""}:${item.name}`
                                }
                                renderItem={(item) => (
                                  <SkillResourceRow
                                    name={item.name}
                                    description={item.description}
                                    titleExtra={
                                      <>
                                        <span className={SKILL_BADGE_CLASS_NAME}>
                                          {s.presetBadge}
                                        </span>
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
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <DialogFooter className="border-t border-popover-border px-4 py-3">
                <Button type="button" variant="outline" onClick={() => setImportOpen(false)}>
                  {s.cancelAction}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* 行详情:布局镜像原生 SkillsSection 的详情弹窗(头部分隔线 + 描述块 + 字段网格)。 */}
          <Dialog
            open={detailSkill !== null}
            onOpenChange={(open) => {
              if (!open) setDetailSkill(null);
            }}
          >
            <DialogContent className="max-h-[min(80vh,640px)] max-w-xl overflow-hidden p-0">
              {detailSkill ? (
                <div className="flex min-h-0 flex-col">
                  <DialogHeader className="border-b border-popover-border px-4 pt-4 pb-3">
                    <DialogTitle className="truncate pr-8 text-ui-lg">
                      {detailSkill.name}
                    </DialogTitle>
                  </DialogHeader>
                  <div className="min-h-0 space-y-4 overflow-auto px-4 py-5">
                    <div className="grid gap-1.5">
                      <div className="text-ui-base font-medium text-foreground">
                        {s.detailDescriptionLabel}
                      </div>
                      <div className="max-h-40 overflow-auto whitespace-pre-wrap text-ui-base/relaxed text-foreground-subtle">
                        {skillSummaryLine(detailSkill) || detailSkill.name}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                      <div className="min-w-0">
                        <div className="text-ui-base font-medium text-foreground">
                          {s.detailCreatedAtLabel}
                        </div>
                        <div className="mt-1 break-all font-mono text-ui-base text-foreground-subtle">
                          {detailSkill.createdAt}
                        </div>
                      </div>
                      <div className="min-w-0 col-span-2">
                        <div className="text-ui-base font-medium text-foreground">
                          {s.detailContentLabel}
                        </div>
                        <div className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-sm text-foreground-subtle">
                          {detailSkill.content}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </DialogContent>
          </Dialog>
        </section>
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}
