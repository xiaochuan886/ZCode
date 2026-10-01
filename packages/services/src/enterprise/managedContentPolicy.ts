/** 企业 runtime 受管内容写保护(`ZCODE_ENTERPRISE_MANAGED_CONTENT=1`)。
 *
 * 企业控制面分发到专家 runtime 的 Skill/MCP 条目统一使用 `enterprise-` 保留前缀
 * (租户共享 Skill 目录、`enterprise-<connector_key>` MCP 槽位)。原生设置页的
 * 删除/复制/改写入口在该标记下拒绝这些保留名,让篡改立即失败,而不是等下一次
 * runtime preparation 才被覆盖回去。普通 ZCode(标记缺省)行为完全不变。
 */

/** 稳定错误码,供企业 UI/远程客户端识别该操作命中受管保留名。 */
export const ENTERPRISE_MANAGED_CONTENT_ERROR_CODE = "enterprise.managed_content";

/** 与 managed-model 策略同构:错误码稳定,文案不作为调用方契约。 */
export class EnterpriseManagedContentPolicyError extends Error {
  readonly code = ENTERPRISE_MANAGED_CONTENT_ERROR_CODE;

  constructor(target: string) {
    super(`Managed enterprise content cannot be modified: ${target}`);
    this.name = "EnterpriseManagedContentPolicyError";
  }
}

export function isEnterpriseManagedContentMode(): boolean {
  return process.env["ZCODE_ENTERPRISE_MANAGED_CONTENT"]?.trim() === "1";
}

export function isEnterpriseManagedContentName(name: string): boolean {
  return name.trim().startsWith("enterprise-");
}

/** 目标名命中保留前缀且企业受管标记开启时拒绝写入;其余情况放行。 */
export function assertNotEnterpriseManagedContent(target: string): void {
  if (isEnterpriseManagedContentMode() && isEnterpriseManagedContentName(target)) {
    throw new EnterpriseManagedContentPolicyError(target);
  }
}
