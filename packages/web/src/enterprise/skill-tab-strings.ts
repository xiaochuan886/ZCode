/**
 * Skill tab 专属文案。presentation.ts 是企业壳层的共享文案表(冻结不改),
 * 本次只把卡片视觉对齐原生 SkillsSection,新增的组头/空态文案集中放在这里。
 * 组件按 EnterpriseApp 下发的 t(zh/en 对象身份)选择语言,结构与 presentation
 * 的 { zh, en } 双语形式保持一致。
 */
const zh = {
  /** 租户共享 Skill 目录的分组标题,对齐原生「已安装 N」的组头形态。 */
  sharedSkillListTitle: "已共享的 Skill",
  /** 目录空态的辅助说明,对齐原生虚线空态容器的 title + description 结构。 */
  sharedSkillEmptyHint: "在上方手工创建,或从下方导入选择器把现有 Skill 共享给整个租户。",
  /** 导入选择器按名称过滤无结果时的空态文案。 */
  importSkillSearchEmpty: "没有匹配的 Skill",
};

const en: Record<keyof typeof zh, string> = {
  sharedSkillListTitle: "Shared skills",
  sharedSkillEmptyHint:
    "Create one above, or share an existing skill with the whole tenant from the import picker below.",
  importSkillSearchEmpty: "No matching skills",
};

export const skillTabStrings = { zh, en };
export type SkillTabStrings = typeof zh;
