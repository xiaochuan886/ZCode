import { useCallback, useEffect, useState } from "react";
import {
  createEnterpriseClient,
  EnterpriseApiError,
  type ImportableTenantSkillView,
  type TenantSkillView,
} from "./api.js";
import { badge, button, field, primary, zh } from "./presentation.js";

const api = createEnterpriseClient();

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
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
        <label className="flex flex-col gap-1 text-ui-sm">
          {t.sharedSkillName}
          <input
            className={field}
            value={skillName}
            placeholder={t.sharedSkillPlaceholder}
            onChange={(event) => setSkillName(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-ui-sm">
          {t.sharedSkillContent}
          <textarea
            className={`${field} min-h-32 font-mono text-ui-sm`}
            value={skillContent}
            placeholder={t.sharedSkillContentPlaceholder}
            onChange={(event) => setSkillContent(event.target.value)}
          />
        </label>
        <div className="flex justify-end">
          <button
            type="button"
            className={primary}
            disabled={busy || !skillName.trim() || !skillContent.trim()}
            onClick={createSkill}
          >
            {t.createSharedSkill}
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-ui-sm font-medium">{t.importSkillTitle}</p>
            <p className="mt-1 text-ui-xs text-foreground-subtle">{t.importSkillHint}</p>
          </div>
          <button type="button" className={button} disabled={busy} onClick={loadImportables}>
            {t.importSkillPick}
          </button>
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
              <input
                className={field}
                value={importFilter}
                placeholder={t.importSkillFilterPlaceholder}
                onChange={(event) => setImportFilter(event.target.value)}
              />
              <ul
                className="flex max-h-72 flex-col gap-2 overflow-y-auto"
                data-testid="enterprise-importable-skills"
              >
                {importables
                  .filter((item) =>
                    item.name.toLowerCase().includes(importFilter.trim().toLowerCase()),
                  )
                  .map((item) => (
                    <li
                      key={`${item.origin}:${item.workspaceId ?? ""}:${item.name}`}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2"
                    >
                      <div className="min-w-0">
                        <strong className="block truncate text-ui-sm font-medium">
                          {item.name}
                        </strong>
                        <span className="block truncate text-ui-xs text-foreground-subtle">
                          {item.description || item.name}
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-1">
                          <span className={badge}>{t.importSkillOriginHome}</span>
                          {item.origin === "workspace" ? (
                            <span className={badge}>
                              {t.importSkillOriginWorkspace}
                              {item.workspaceName ? ` · ${item.workspaceName}` : ""}
                            </span>
                          ) : null}
                          {item.alreadyImported ? (
                            <span className={badge}>{t.importSkillAlreadyImported}</span>
                          ) : null}
                        </span>
                      </div>
                      <button
                        type="button"
                        className={button}
                        disabled={busy || item.alreadyImported}
                        onClick={() => importSkill(item)}
                      >
                        {item.alreadyImported ? t.importSkillAlreadyImported : t.importSkillAction}
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          )
        ) : null}
      </div>
      {skills.length === 0 ? (
        <p className="text-ui-sm text-foreground-subtle">{t.noSharedSkill}</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="enterprise-settings-skills">
          {skills.map((skill) => (
            <li
              key={skill.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2"
            >
              <div className="min-w-0">
                <strong className="block truncate text-ui-sm font-medium">{skill.name}</strong>
                <span className="block truncate text-ui-xs text-foreground-subtle">
                  {skill.content.split("\n").find((line) => line.trim() !== "") ?? skill.name}
                </span>
              </div>
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => deleteSkill(skill)}
              >
                {t.deleteSharedSkill}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
