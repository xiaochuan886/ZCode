# 客户工作区 MVP 验收记录

验收日期：2026-10-01。工作树：`codex/enterprise-mvp`。

## 已实现的产品路径

- 内部专家登录，选择或创建客户；客户名称必填，类型可选。
- 一个客户对应一个持久 workspace/runtime；原生 session 作为案例，原生归档和恢复管理生命周期。
- 客户文件夹下复用原生会话列表；聊天区移除两层企业 header；账号入口集中在原生侧栏底部。
- 企业归档和搜索查询当前 runtime 的原生任务索引；客户切换先卸载 Root 并关闭旧 socket。
- 租户管理员配置自定义供应商，支持 OpenAI Chat Completions 与 Anthropic Messages；真实 API Key 仅服务端加密保存。
- 企业 runtime 在服务端限制个人供应商、OAuth、通用凭据和数据库目录的写入入口，普通设置仍可使用。
- 旧 Case workspace 独立保留；已结案历史工作区可打开，旧状态保持不变。

## 自动验证

| 验证                                | 结果                                                  |
| ----------------------------------- | ----------------------------------------------------- |
| `pnpm typecheck`                    | 通过                                                  |
| `pnpm lint`                         | 0 errors，70 条既有 warnings                          |
| `pnpm architecture:check --changed` | 0 violations                                          |
| Enterprise tests                    | 49/49                                                 |
| Server managed model policy tests   | 3/3                                                   |
| Web enterprise API tests            | 12/12                                                 |
| Web build                           | 通过                                                  |
| Docker runtime image build          | 通过，测试 tag `zcode-enterprise-runtime:customer-ux` |
| Docker E2E（新镜像）                | 2/2                                                   |
| 本次修改及新增文件 Oxfmt 检查       | 通过                                                  |
| `git diff --check`                  | 通过                                                  |
| `pnpm fmt:check`                    | 失败：33 个与本次修改无关的既有文件存在格式问题       |

宿主 pnpm 使用 Node 26.5.1；测试容器使用 Node 24.21.0。仓库要求的精确版本为 24.14.0，当前环境会产生 engine warning。

## 真实浏览器验证

使用独立临时数据库与测试凭据，没有迁移真实客户数据。

1. 登录、保存自定义供应商字段、创建客户 A。
2. 从账号菜单返回客户工作区，仅填写名称创建客户 B。
3. 从 B 切换至 A：旧 WebSocket 关闭一次，当前客户标签正确，B 的草稿未进入 A。
4. 560 × 900 下 `scrollWidth === clientWidth === 560`，Composer 标签为客户名，输入和发送按钮可见。
5. 同一客户创建并恢复两个不同原生 session，复用同一个客户 runtime。
6. 通过原生 Composer 建立案例；任务在客户文件夹下显示。
7. 原生归档后 SQLite `archived=1`；归档页显示案例与客户名称；恢复后 `archived=0`。
8. 新镜像的真实 RPC 拒绝供应商、通用凭据和数据库目录写入，允许普通语言设置。

截图：

- [桌面界面](/Users/massifserver/.codex/visualizations/2026/09/30/01a0f19f-8c8a-7372-83c4-a0df2ec9751d/customer-workspace-desktop.png)
- [560px 界面](/Users/massifserver/.codex/visualizations/2026/09/30/01a0f19f-8c8a-7372-83c4-a0df2ec9751d/customer-workspace-560.png)

## 验证边界

模型测试使用虚假 API Key，真实供应商推理未验证。测试中的模型 503 和重试提示符合该凭据不可用的结果；原生会话、任务索引、归档和恢复已独立验证。

代码尚未部署，真实数据迁移尚未执行。v2 → v3 迁移已使用测试数据库验证；旧 Case 目录与会话不会自动合并到客户 workspace。
