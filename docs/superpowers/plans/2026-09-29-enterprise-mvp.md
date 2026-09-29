# Enterprise MVP Implementation Plan

> **For agentic workers:** Use subagent-driven development. Track steps here; each task must be tested and reviewed before it is marked complete.

**Goal:** Deliver the nine approved MVP issues in an opt-in enterprise gateway around native ZCode.

**Architecture:** A separate enterprise package owns business data and authorization. Its gateway routes an authenticated active Case to a private native ZCode runtime. Web adds a thin enterprise shell around native Root.

**Tech Stack:** TypeScript, Node 24 `node:sqlite`, Hono, React, native ZCode server and UI, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-29-enterprise-mvp-design.md`

## Global Constraints

- Preserve native Agent, Composer, modes, Session, Skill and MCP behavior.
- Every API query scopes tenant-owned records to a current membership; never trust a client tenant ID alone.
- `workspaceId` is the Case's absolute path, not an invented identity URI.
- Process runtime is for development; container runtime is required for security isolation acceptance.
- Enterprise mode must be opt-in and must not alter ordinary Desktop or Web usage.
- No direct runtime URL or token is returned to browsers.

## Task 1: Enterprise domain, persistence and authentication

**Files:** `packages/enterprise/package.json`, `packages/enterprise/tsconfig.json`, `packages/enterprise/src/store.ts`, `auth.ts`, `types.ts`, `index.ts`, `test/store.test.ts`, `test/auth.test.ts`; workspace package and architecture policy only if required.

**Interfaces produced:** `EnterpriseStore` with tenant/user/membership/ServiceSpace/ServiceObject/Case CRUD, case status transitions, active Case session binding, shared Skill and MCP binding records; `EnterpriseAuth` with password login, session issue/resolve/revoke, same-origin/CSRF validation. Export DTO and error types through `index.ts`.

- [ ] Add failing Node tests for two-tenant authorization, snapshot immutability, status transitions, revoked membership, password and session behavior.
- [ ] Implement versioned SQLite schema with foreign keys, unique constraints and transactions. Use asynchronous filesystem access for directories and SQLite's synchronous transaction boundary only where necessary.
- [ ] Implement explicit role checks and generic errors that do not reveal cross-tenant record existence.
- [ ] Add operator bootstrap command to create initial tenant admin with a password supplied interactively or via stdin, never logged.
- [ ] Run package tests, typecheck, lint, architecture check; commit.

## Task 2: Runtime manager and authenticated gateway

**Files:** `packages/enterprise/src/runtime.ts`, `gateway.ts`, `proxy.ts`, `entry.ts`, `test/runtime.test.ts`, `test/gateway.test.ts`, container definition and run documentation.

**Interfaces consumed:** Task 1's store and auth exports. **Produces:** `RuntimeManager.ensure(case)`, `stop(case)`, `getBinding(case)`, and an HTTP server that serves `/api/enterprise/*` and routes native HTTP/WebSocket to the active Case runtime.

- [ ] Add failing tests for case-specific paths/tokens, unauthorized HTTP and WebSocket denial, forbidden privileged routes, stale runtime restart and preserved Case files.
- [ ] Implement process adapter for local development and container adapter with one unprivileged container/Case and only Case volumes mounted.
- [ ] Implement server-side active Case binding and per-request membership check. Strip browser-supplied runtime auth and inject the private token upstream. Close old sockets on Case switch.
- [ ] Serve built native Web assets from the gateway and implement startup/health checks.
- [ ] Run package tests, typecheck, lint, architecture check; commit.

## Task 3: Case context, shared Skills and MCP binding

**Files:** `packages/enterprise/src/materialize.ts`, `test/materialize.test.ts`; native integration files only when proven necessary.

**Interfaces consumed:** Task 1's Case snapshot, Skill and MCP records. **Produces:** `prepareCaseWorkspace(case)` called before runtime start/open.

- [ ] Add failing tests for immutable authorized context, cross-tenant Skill exclusion, source Case traceability, MCP credential scoping, and missing source tolerance.
- [ ] Atomically write Case context and native workspace instructions, materialize native `.zcode/skills`, and configure native MCP from authorized bindings.
- [ ] Demonstrate native Skill discovery and MCP configuration in an integration test; document any minimal upstream-core change.
- [ ] Run tests, typecheck, lint, architecture check; commit.

## Task 4: Enterprise Web shell

**Files:** `packages/web/src/enterprise/*`, `packages/web/src/main.tsx`, any focused Web CSS/test files.

**Interfaces consumed:** `/api/enterprise/bootstrap`, login/logout, ServiceSpace, ServiceObject and Case CRUD, activate Case, and Case runtime binding. **Produces:** opt-in enterprise login/navigation around existing `Root`.

- [ ] Add UI tests for login, create Case requirements, Case switch teardown, status change and visible context header.
- [ ] Build responsive, localized enterprise shell using existing design tokens/components. Do not edit Composer or mode controls.
- [ ] On Case switch close the prior WebSocket, clear native Root state by remount, activate Case server-side, and rebootstrap from authorized binding.
- [ ] Run Web build, tests, typecheck, lint and architecture check; commit.

## Task 5: Isolation and native regression gate

**Files:** `packages/enterprise/test/e2e/*`, `packages/enterprise/README.md`, CI workflow if project convention supports it.

- [ ] Run two tenants with multiple users, spaces and Cases against the gateway and container runtime. Assert cross-tenant denial for REST, native RPC/WebSocket, files, shell, Skills, MCP and context.
- [ ] Run native ZCode smoke flows: create/continue session, Plan/Build/Edit/Yolo, files, shell, Skill, MCP, streaming/tool UI, attachments and plugin/hooks where configured.
- [ ] Exercise crash/restart, stale mapping, rapid Case switch, removed member, direct runtime request, missing sources, close/reopen.
- [ ] Run all package tests, `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, and Web/server builds. Record every result and any environment limitation.
- [ ] Broad review against issues #1–#9, resolve findings, then prepare a reviewable branch/PR.
