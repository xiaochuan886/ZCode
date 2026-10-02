import type { ReactNode } from "react";
import { Trash2, WandSparkles } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 技能资源行:从 SkillsSection.renderSkillRow 抽出的纯展示组件,外层容器
 * (surface 圆角 + border/50 分隔线)由 SettingsResourceList 负责。行为完全由
 * props 驱动:不传 onToggle/onDelete 就不渲染对应控件,行内文案(「暂无描述」
 * 兜底、删除 aria-label)沿用 useZCodeIntl,调用方无需自带 i18n。
 * 企业设置 Skill tab 复用同一行组件;plugin 头像等定制内容经 icon 槽注入。
 */
export interface SkillResourceRowProps {
  name: string;
  /** 缺省或空串时回退到原生「暂无描述」文案。 */
  description?: string;
  /** 仅在传 onToggle 时随 Switch 展示。 */
  enabled?: boolean;
  /** 缺省渲染 WandSparkles 头像块;plugin 技能传 PluginStoreAvatar。 */
  icon?: ReactNode;
  /** 名称行内附加槽(放在名称右侧),用于来源徽标等行内元信息。 */
  titleExtra?: ReactNode;
  /** 提供时名称/描述区渲染为可聚焦的 role=button(点开详情)。 */
  onOpen?: () => void;
  /** 提供时渲染启停 Switch。 */
  onToggle?: (checked: boolean) => void;
  /** 提供时渲染行尾删除图标按钮(aria-label 用原生 common.delete)。 */
  onDelete?: () => void;
  /** 删除按钮禁用态(企业侧串行 mutation 的 busy 守卫);原生不传。 */
  deleteDisabled?: boolean;
  /** Switch 与删除按钮之间的附加槽(原生「分享到租户」、企业导入按钮)。 */
  trailingExtra?: ReactNode;
}

export function SkillResourceRow({
  name,
  description,
  enabled,
  icon,
  titleExtra,
  onOpen,
  onToggle,
  onDelete,
  deleteDisabled = false,
  trailingExtra,
}: SkillResourceRowProps) {
  const { intl } = useZCodeIntl();
  const summary = (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="truncate text-ui-base font-medium text-foreground">{name}</span>
        {titleExtra}
      </div>
      <div className="mt-0.5 truncate text-ui-sm text-foreground-subtle">
        {description || intl.formatMessage({ id: "settings.skills.noDescription" })}
      </div>
    </>
  );
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-hover">
      {icon ?? (
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background text-foreground-subtle"
          aria-hidden="true"
        >
          <WandSparkles className="size-4" />
        </div>
      )}
      {onOpen ? (
        <div
          role="button"
          tabIndex={0}
          className="min-w-0 cursor-default rounded-md outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          onClick={onOpen}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onOpen();
            }
          }}
        >
          {summary}
        </div>
      ) : (
        <div className="min-w-0">{summary}</div>
      )}
      <div className="flex shrink-0 items-center gap-2">
        {onToggle ? <Switch checked={enabled} onCheckedChange={onToggle} /> : null}
        {trailingExtra}
        {onDelete ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-foreground-subtle hover:bg-destructive/10 hover:text-destructive"
            aria-label={intl.formatMessage({ id: "common.delete" })}
            title={intl.formatMessage({ id: "common.delete" })}
            disabled={deleteDisabled}
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
