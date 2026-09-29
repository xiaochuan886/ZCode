# Enterprise MVP design

Source requirements: `xiaochuan886/ZCode` issues #1–#9. This design records the implementation choices for the approved two-layer architecture.

## Boundary and ownership

- A new `@zcode/enterprise` package owns users, tenants, memberships, ServiceSpaces, ServiceObjects, Cases, shared Skill records, MCP bindings, and Case/runtime mappings. Its SQLite database is the sole owner of these facts.
- Existing ZCode owns Composer, sessions, modes, tools, files, Skills execution, MCP execution, plugins and permission decisions. Enterprise code neither copies the conversation nor changes Agent runtime types.
- The enterprise HTTP gateway is the browser's sole origin. It authenticates every enterprise API and native runtime HTTP/WebSocket request, resolves the user's active Case on the server, and forwards only to that Case's runtime. It denies trusted-host, remote-connect, callback and other privileged runtime endpoints from normal browsers.
- Each Case has an immutable, distinct absolute workspace directory. The native v4 session `workspaceId` is this path; arbitrary `enterprise://` identity cannot be used until ZCode's resolver supports it. The Case/runtime/session mapping records the path and native session ID where available.

## Identity and data

`EnterpriseStore` is the sole writer of enterprise rows. Every tenant-owned read or write starts with an actor user ID, checks current membership, then checks the parent chain in one SQLite transaction. Cross-tenant and absent resources return the same `not_found` error. It stores an immutable ServiceObject snapshot at Case creation, while ServiceObject edits affect only future Cases. Case workspace paths are generated from the server-controlled root and opaque Case ID. Session rows store only a SHA-256 digest of the browser bearer token, a CSRF token digest and the active Case ID; membership is checked again on each resolve and Case activation. Revoking a membership invalidates that member's active access immediately. Schema upgrades use `PRAGMA user_version` within a transaction, and foreign keys are enabled on every connection.

The authentication sequence is `password verification → issue random session and CSRF secrets → set HttpOnly SameSite cookie → resolve digest on each request → check current membership → validate Origin and CSRF on mutation`. Passwords use scrypt with a per-user random salt and constant-time comparison. The operator bootstrap command takes its password from a TTY prompt or stdin without printing it.

Users log in with a password verified using a memory-hard hash. An operator bootstrap command creates the first admin; there is no open public registration. Browser sessions use an HttpOnly, SameSite cookie and a hashed, revocable token in SQLite. Mutating requests require a same-origin check and CSRF token. Tenant IDs, service space IDs and Case IDs from clients are always checked against current membership and parent ownership.

Membership roles are `admin` and `member`. An admin manages ServiceSpaces and tenant members. Members create ServiceObjects and Cases in their tenant and can access that tenant's Cases. A Case stores a JSON snapshot of its ServiceObject's name, type and metadata at creation. Subsequent ServiceObject edits never change that snapshot. Status transitions are `open → in_progress → resolved → closed`, plus reopen to `in_progress`.

An admin provisions a user and membership atomically through the gateway, using a server-hashed password. Duplicate email is a conflict; there is no implicit account takeover or password reset. Admins can remove tenant memberships, which immediately clears their active Case binding. Space renaming is admin-only.

Only current tenant admins can rename a ServiceSpace; its ID, tenant ownership and existing Object/Case links stay fixed. `PATCH /api/enterprise/spaces/:id` changes only its name. A different tenant's admin receives the same `not_found` result as for an absent space. `POST /api/enterprise/users` creates the user and membership in one transaction; a duplicate email is a conflict and never attaches an existing account implicitly. Both operations require the session's same-origin and CSRF checks.

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

The gateway owns only in-memory live process/socket handles; SQLite owns the active Case binding and native session ID. For every request it resolves the session, then asks SQLite for the active Case using current membership. Activation closes this session's prior sockets before changing the binding; explicit membership removal clears the affected active Case bindings and immediately closes all live sockets for that user. A runtime restart retains the Case workspace and changes its private token; requests never reuse an unhealthy handle. The browser contract includes bootstrap, login/logout, scoped space/object/Case lists and creation, Case activation, status transition, native session binding for the active Case, publishing a workspace Skill, and admin MCP binding endpoints under `/api/enterprise`. Mutations require CSRF and same-origin validation. Missing authentication yields 401, inaccessible Case or parent yields 404, invalid input yields 400, and runtime unavailability yields 503. A published Skill path must resolve inside that Case's native skills directory, including symlink resolution; the server reads and hashes its SKILL.md. An MCP secret reference names a server environment variable, resolved only while materializing an authorized Case and never returned to browsers.

The native proxy canonicalizes and rejects malformed or multiply encoded paths before routing, denies privileged native routes, removes hop-by-hop and connection-nominated request headers, replaces browser cookies and authorization with the private runtime credential, and never forwards native cookies to the browser. Redirects must stay inside the gateway's allowed native path space. WebSocket handshakes forward only the required public upgrade headers. A native task ID can be bound only to the active Case when that Case's isolated runtime task index contains a non-deleted row whose task ID, workspace key and workspace path match the server-issued Case workspace path; an unindexed or foreign ID returns the same `not_found` response.

The runtime manager stops an unhealthy or replaced Case runtime before it materializes `CASE_CONTEXT.md`, `AGENTS.md`, Skills or MCP config, then starts the replacement. Before first materialization it removes any stale named container left by an earlier gateway process. Ordinary requests reuse a healthy runtime without rewriting its writable workspace. Skill and MCP binding changes stop affected Case runtimes before their next materialization; membership removal also revokes those runtimes' relay credentials before they are restarted by a remaining member.

Production isolation uses one unprivileged container per active Case with only that Case's workspace/data volumes mounted; no host home, Docker socket or other tenant volume is mounted. The process adapter is development-only and makes no host-file/shell isolation claim. Runtime listeners bind loopback or a private container network and use a random per-runtime token. The gateway never returns direct runtime addresses or tokens to browsers. Native `/api/rpc-host-capability`, `/ws/host`, remote-connect and bot callback routes are denied at the gateway.

## Case context, Skills and MCP

On Case creation/open, the control plane writes a generated `CASE_CONTEXT.md` and a minimal `AGENTS.md` into that Case's workspace. The content is produced only from the authorized Case snapshot, and the file write is atomic. The snapshot is authoritative even if the ServiceObject changes. User edits to generated files are overwritten on Case open; this is stated in the UI.

Publishing a native `SKILL.md` stores a tenant-scoped copy with its source Case and content hash. Runtime preparation materializes only authorized tenant or ServiceSpace shared Skills under that Case's `.zcode/skills`; native Skill discovery and execution stay unchanged. Runtime-specific HOME/data directories prevent a user's global Skills from leaking between tenants. MCP bindings contain a per-tenant or per-ServiceSpace endpoint and server-side secret reference. Runtime preparation provides only bindings authorized for that Case. `.zcode/config.json` contains only a gateway relay URL and a random per-Case/per-binding relay token; the upstream bearer secret stays in the gateway environment and is injected only when proxying a request. Each relay request checks the token against that exact Case and binding, confirms the binding is still authorized for the Case, and streams HTTP request/response bodies to the stored HTTPS endpoint. Stopping the runtime revokes its relay tokens. A missing secret reference emits an operator diagnostic and skips that binding without preventing ordinary Agent usage.

## Web experience

The Web entry checks whether the enterprise gateway is enabled. It shows login, ServiceSpace and ServiceObject selectors, Case creation/list/status, and an always-visible Case header around the existing `Root`. It passes the authorized Case workspace path and mapped native session ID into `Root`, with arbitrary workspace opening disabled. It does not modify the Composer or mode controls. Case switching tears down the old `Root` and WebSocket before loading the new Case.

The Web entry probes `/api/enterprise/bootstrap` before opening a native socket. A `404` means ordinary ZCode Web mode; any other probe failure is visible and retryable. The enterprise shell owns only the current UI selection and the browser socket. The gateway owns login, membership, the active Case, CSRF token and all business records. Login and every mutation send the bootstrap CSRF token and same-origin cookies. A Case requires a ServiceSpace, ServiceObject, title and category. A successful Case activation first unmounts native Root and closes its socket, then loads the authorized bootstrap and creates a new socket/Root with the Case path and session ID. A failed activation stays outside Root until bootstrap determines the authorized active Case. Status updates follow server transitions; the UI never assumes a local transition succeeded. Enterprise mode cannot open arbitrary workspaces. The shell uses Chinese/English labels based on browser language, semantic tokens, and keeps selectors and actions usable on narrow Web viewports.

The native UI session store remains the owner of the current task ID. A public read-only hook exposes that ID for an exact Case workspace path. While the Case Root is mounted, Web posts non-null ID changes to `/api/enterprise/cases/:id/session`; the gateway accepts the binding only if the same authenticated session still has that Case active and the task belongs to its workspace. A missing task index may race native persistence, so the Web request retries bounded 404/409 responses and surfaces a final failure. Requests from an unmounted Case are aborted; stale responses never update Web state. The gateway persists the mapping for later bootstrap. A null draft ID does not erase the prior native session binding.

## Acceptance and regression

Tests cover two tenants, multiple users/spaces/Cases, cross-tenant API and runtime denial, immutable snapshots, status transitions, stale runtime mapping and stale-container removal before workspace writes, Case switching, immediate WebSocket revocation, Skill and MCP distribution, MCP secret exclusion and fixed-binding streaming relay, context isolation, and container workspace mounts. Container mode requires a relay origin that Case containers can reach; production uses the configured HTTPS enterprise origin, and local Docker development uses a host interface reachable at `host.docker.internal`. Native Agent smoke tests cover session creation/continuation, Composer modes, files, shell, Skills, MCP, and streaming. The MVP is complete only when the full isolation and regression suite passes in a documented container-enabled environment.

## Migration and non-goals

Enterprise mode is opt-in and leaves the ordinary ZCode server/Desktop paths intact. SQLite schema migrations are versioned and transactionally applied. No SSO, billing, workflow engine, new RAG stack, new Agent/Session runtime, or Composer rewrite is included.
