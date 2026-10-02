/**
 * Skill tab 专属文案。presentation.ts 是企业壳层的共享文案表(冻结不改),
 * tab 内新增文案集中放在这里。组件按 EnterpriseApp 下发的 t(zh/en 对象身份)
 * 选择语言,结构与 presentation 的 { zh, en } 双语形式保持一致。
 */
const zh = {
  /** 租户共享 Skill 目录的分组标题,对齐原生「已安装 N」的组头形态。 */
  sharedSkillListTitle: "已共享的 Skill",
  /** 目录空态的辅助说明,对齐原生 PluginInstallEmptyState 的 title + description 结构。 */
  sharedSkillEmptyHint: "从个人运行时或客户工作区导入现有 Skill,或手工新建一个共享给整个租户。",
  /** 空态大按钮:手工新建(打开创建弹窗)。 */
  newSkillAction: "新建 Skill",
  /** 空态大按钮:从个人运行时/客户工作区导入(打开导入弹窗)。 */
  importSkillAction: "导入 Skill",
  /** 创建弹窗标题。 */
  createDialogTitle: "新建共享 Skill",
  /** 导入弹窗标题。 */
  importDialogTitle: "导入共享 Skill",
  /** 弹窗通用取消按钮。 */
  cancelAction: "取消",
  /** 详情弹窗:描述块标题。 */
  detailDescriptionLabel: "描述",
  /** 详情弹窗:创建时间字段。 */
  detailCreatedAtLabel: "创建时间",
  /** 详情弹窗:内容预览字段。 */
  detailContentLabel: "内容 (SKILL.md)",
  /** 导入选择器按名称过滤无结果时的空态文案。 */
  importSkillSearchEmpty: "没有匹配的 Skill",
};

const en: Record<keyof typeof zh, string> = {
  sharedSkillListTitle: "Shared skills",
  sharedSkillEmptyHint:
    "Import an existing skill from your personal runtime or a customer workspace, or create a new one to share with the whole tenant.",
  newSkillAction: "New skill",
  importSkillAction: "Import skill",
  createDialogTitle: "New shared skill",
  importDialogTitle: "Import shared skill",
  cancelAction: "Cancel",
  detailDescriptionLabel: "Description",
  detailCreatedAtLabel: "Created at",
  detailContentLabel: "Content (SKILL.md)",
  importSkillSearchEmpty: "No matching skills",
};

export const skillTabStrings = { zh, en };
export type SkillTabStrings = typeof zh;
