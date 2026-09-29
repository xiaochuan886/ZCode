# Enterprise MVP design

Source requirements: `xiaochuan886/ZCode` issues #1–#9. This design records the implementation choices for the approved two-layer architecture.

## Boundary and ownership

- A new `@zcode/enterprise` package owns users, tenants, memberships, ServiceSpaces, ServiceObjects, Cases, shared Skill records, MCP bindings, and Case/runtime mappings. Its SQLite database is the sole owner of these facts.
- Existing ZCode owns Composer, sessions, modes, tools, files, Skills execution, MCP execution, plugins and permission decisions. Enterprise code neither copies the conversation nor changes Agent runtime types.
- The enterprise HTTP gateway is the browser's sole origin. It authenticates every enterprise API and native runtime HTTP/WebSocket request, resolves the user's active Case on the server, and forwards only to that Case's runtime. It denies trusted-host, remote-connect, callback and other privileged runtime endpoints from normal browsers.
- Each Case has an immutable, distinct absolute workspace directory. The native v4 session `workspaceId` is this path; arbitrary `enterprise://` identity cannot be used until ZCode's resolver supports it. The Case/runtime/session mapping records the path and native session ID where available.

## Identity and data

Users log in with a password verified using a memory-hard hash. An operator bootstrap command creates the first admin; there is no open public registration. Browser sessions use an HttpOnly, SameSite cookie and a hashed, revocable token in SQLite. Mutating requests require a same-origin check and CSRF token. Tenant IDs, service space IDs and Case IDs from clients are always checked against current membership and parent ownership.

Membership roles are `admin` and `member`. An admin manages ServiceSpaces and tenant members. Members create ServiceObjects and Cases in their tenant and can access that tenant's Cases. A Case stores a JSON snapshot of its ServiceObject's name, type and metadata at creation. Subsequent ServiceObject edits never change that snapshot. Status transitions are `open → in_progress → resolved → closed`, plus reopen to `in_progress`.

## Runtime and routing

```text
browser request /ws or /api/*
  → gateway authenticates user and active Case
  → checks current membership and Case ownership
  → runtime manager ensures Case runtime exists
  → gateway forwards to that runtime with its private token
  → native ZCode HTTP/RPC service executes
```

The active Case is a server-side session property. Switching it revokes the prior browser WebSocket by closing the connection, changes the session binding, then reloads the native Root so in-memory workspace/session stores cannot cross Cases. Runtime mappings survive process restarts. A startup health check reattaches or restarts a stale runtime. Closing a Case stops its runtime but preserves its workspace and native session data. Removing a membership makes the next request fail; existing sockets are closed on the next authorization check or explicit membership change.

Production isolation uses one unprivileged container per active Case with only that Case's workspace/data volumes mounted; no host home, Docker socket or other tenant volume is mounted. The process adapter is development-only and makes no host-file/shell isolation claim. Runtime listeners bind loopback or a private container network and use a random per-runtime token. The gateway never returns direct runtime addresses or tokens to browsers. Native `/api/rpc-host-capability`, `/ws/host`, remote-connect and bot callback routes are denied at the gateway.

## Case context, Skills and MCP

On Case creation/open, the control plane writes a generated `CASE_CONTEXT.md` and a minimal `AGENTS.md` into that Case's workspace. The content is produced only from the authorized Case snapshot, and the file write is atomic. The snapshot is authoritative even if the ServiceObject changes. User edits to generated files are overwritten on Case open; this is stated in the UI.

Publishing a native `SKILL.md` stores a tenant-scoped copy with its source Case and content hash. Runtime preparation materializes only authorized tenant or ServiceSpace shared Skills under that Case's `.zcode/skills`; native Skill discovery and execution stay unchanged. Runtime-specific HOME/data directories prevent a user's global Skills from leaking between tenants. MCP bindings contain a per-tenant or per-ServiceSpace endpoint and server-side secret reference. Runtime preparation provides only bindings authorized for that Case. Failed/missing Skill or MCP sources are reported without preventing ordinary Agent usage.

## Web experience

The Web entry checks whether the enterprise gateway is enabled. It shows login, ServiceSpace and ServiceObject selectors, Case creation/list/status, and an always-visible Case header around the existing `Root`. It passes the authorized Case workspace path and mapped native session ID into `Root`, with arbitrary workspace opening disabled. It does not modify the Composer or mode controls. Case switching tears down the old `Root` and WebSocket before loading the new Case.

## Acceptance and regression

Tests cover two tenants, multiple users/spaces/Cases, cross-tenant API and runtime denial, immutable snapshots, status transitions, stale runtime mapping, Case switching, revoked membership, Skill and MCP distribution, context isolation, and container workspace mounts. Native Agent smoke tests cover session creation/continuation, Composer modes, files, shell, Skills, MCP, and streaming. The MVP is complete only when the full isolation and regression suite passes in a documented container-enabled environment.

## Migration and non-goals

Enterprise mode is opt-in and leaves the ordinary ZCode server/Desktop paths intact. SQLite schema migrations are versioned and transactionally applied. No SSO, billing, workflow engine, new RAG stack, new Agent/Session runtime, or Composer rewrite is included.
