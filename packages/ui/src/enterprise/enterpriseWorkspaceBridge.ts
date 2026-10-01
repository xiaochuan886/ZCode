/**
 * 企业客户工作区桥:侧边栏客户行 → 当前专家 runtime 内的原生工作区 tab。
 * 模块级事件总线,避免为这一动作扩展 Root 的 props 面;
 * Root 在企业上下文存在时订阅,普通模式零开销。
 */
type EnterpriseWorkspaceOpenListener = (workspacePath: string) => void;

const listeners = new Set<EnterpriseWorkspaceOpenListener>();

export function openEnterpriseWorkspace(workspacePath: string): void {
  for (const listener of listeners) listener(workspacePath);
}

export function subscribeEnterpriseWorkspaceOpen(
  listener: EnterpriseWorkspaceOpenListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
