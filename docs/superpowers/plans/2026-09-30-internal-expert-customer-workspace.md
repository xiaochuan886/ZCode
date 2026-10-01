# Internal Expert Customer Workspace Implementation Plan

> **For agentic workers:** Use the approved spec and implement each task with focused tests before code changes. Keep unrelated local changes.

**Goal:** Internal experts open one persistent ZCode workspace per customer and use native sessions as cases, while enterprise authorization and legacy data remain intact.

**Architecture:** `EnterpriseStore` owns customers, membership, active workspace routing and tenant model credentials. The native ZCode runtime owns workspace files, memory, Skills, MCP execution, sessions and archive state. Web owns only transient navigation and drafts. Gateway activation tears down the prior socket before binding a new authorized workspace.

**Tech Stack:** TypeScript, React, Node SQLite, ZCode RPC, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-30-internal-expert-customer-workspace-design.md`

## Global Constraints

- Run `node scripts/check-workspace-freshness.mjs` and `pnpm architecture:check --changed` before code changes; read `pnpm architecture:context enterprise`, `web`, and `ui` as applicable.
- Preserve v2 SQLite rows, existing Case workspace directories, native session indexes, and credential records. Never merge old Case directories automatically.
- The identity key is `workspaceIdentity?.trim() || workspacePath`; the path remains the filesystem/cwd value.
- Do not add a second accepted session state or enterprise Case row for new native sessions.
- Keep the native Root, Composer, permissions, conversation list and archive operations as owners of Agent interaction.
- Use `DESIGN.md` and `text-ui-*` typography for UI changes; verify desktop and 560 × 900 Web presentation.
- Run `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, focused package tests and Web build; report actual failures.

---

### Task 1: Customer schema and migration

**Files:** `packages/enterprise/src/store-base.ts`, `packages/enterprise/src/store.ts`, `packages/enterprise/src/types.ts`, `packages/enterprise/test/store.test.ts`.

- [ ] Write tests that open a v2 database containing two Cases for one ServiceObject and verify migration retains both paths, statuses, native session IDs and credentials while creating exactly one stable Customer workspace.
- [ ] Run `pnpm --filter @zcode/enterprise test` and confirm the new tests fail for the missing Customer behavior.
- [ ] Add a transactional v3 migration and Customer store operations, including authorization, stable workspace identity and read-only legacy mapping. Make retries idempotent and report unsafe or missing old paths without replacing them.
- [ ] Rerun focused store tests and the full enterprise package tests.

### Task 2: Customer activation and runtime routing

**Files:** `packages/enterprise/src/gateway.ts`, `packages/enterprise/src/enterprise-api.ts`, `packages/enterprise/src/runtime.ts`, relay and materialization modules, corresponding `packages/enterprise/test/*.test.ts`.

- [ ] Write tests for two sessions in one Customer sharing one runtime, two Customers remaining isolated, revoked membership closing access, and legacy Case activation retaining its original path.
- [ ] Run focused tests to observe failures, then implement `GET/POST /customers`, `POST /customers/:id/activate`, Customer bootstrap and explicit legacy reads/activation.
- [ ] Bind runtime, relay and materialization to the authorized Customer workspace. Keep legacy Case runtime routing separate. Never regenerate `AGENTS.md` or `CASE_CONTEXT.md` for Customer workspaces.
- [ ] Rerun focused tests, all enterprise tests and `pnpm architecture:check --changed`.

### Task 3: Native UI integration

**Files:** `packages/ui/src/root/types.ts`, `packages/ui/src/Root.tsx`, app-shell and sidebar components required by the existing prop chain, relevant UI tests.

- [ ] Add a focused test for enterprise workspace labels and switch callback: clicking another Customer must call the enterprise callback, not native open-folder logic.
- [ ] Add optional Root props for read-only Customer names, enterprise profile and enterprise actions; pass only IDs and callbacks, never another Customer path or runtime into the current Root.
- [ ] Hide native personal Z.ai login, Coding Plan purchase and duplicate account controls in enterprise mode; retain normal ZCode behavior outside enterprise mode.
- [ ] Run focused UI tests and typecheck.

### Task 4: Web customer flow

**Files:** `packages/web/src/enterprise/**`, `packages/web/test/enterpriseApi.test.ts`, browser E2E scenario where available.

- [ ] Test customer list, create/open, native session creation/archive ownership, failed activation recovery, tenant switch and legacy workspace access.
- [ ] Replace the ServiceSpace/Object/Case creation flow with Customer selection. Keep native Root full height and remove both enterprise header rows while a workspace is open.
- [ ] On switch, synchronously unmount Root and close the old socket before activation. Reject stale responses by generation; mount only from fresh authorized bootstrap.
- [ ] Pass Customer navigation and enterprise account callbacks into Root; use native session history as the case list.
- [ ] Run Web API tests, Web build and available browser E2E checks.

### Task 5: Tenant custom model configuration

**Files:** enterprise model credential/provisioning modules and tests, Web model settings UI, native enterprise-mode settings visibility.

- [ ] Test admin write/revoke, member status read, no client-visible secret, tenant-wide readiness and Customer runtime propagation for a configurable custom provider.
- [ ] Reuse the server-side protected credential/relay path. Show only custom provider configuration in enterprise mode; hide Z.ai personal login and plan purchase entry points.
- [ ] Verify one configured tenant connection works for two Customer workspaces without re-entry, and revocation blocks later requests.

### Task 6: Integration and release gate

- [ ] Run enterprise package tests, Web build, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, and `pnpm architecture:check --changed`.
- [ ] Verify the accepted path in a browser: login → open Customer → create two native sessions → archive one → switch Customer → return and recover history.
- [ ] Check `git diff --check` and inspect the final diff for unrelated changes, unsafe migration behavior, credentials in logs and stale ServiceSpace/Case UX references.
- [ ] Report changed state owners, validation evidence, limitations and migration risks.
