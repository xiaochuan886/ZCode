# Enterprise gateway

This opt-in gateway serves the built Web client and routes an authenticated active Customer to one private native ZCode runtime. A Customer owns one long-lived workspace and runtime; every native ZCode session in that workspace is a case in the product language. The old per-Case hierarchy (ServiceSpace/ServiceObject/Case) is removed without a compatibility path: schema v4 drops it destructively. The gateway does not change ordinary desktop or Web entry points.

From the repository root, use Node 24 and build the native server and Web client:

```sh
pnpm install --frozen-lockfile
pnpm --filter @zcode/server build
pnpm --filter @zcode/web build
docker build -f packages/enterprise/Dockerfile.runtime -t zcode-enterprise-runtime:local .
pnpm --filter @zcode/enterprise test
RUN_ENTERPRISE_DOCKER_E2E=1 pnpm --filter @zcode/enterprise test:e2e
pnpm --filter @zcode/enterprise bootstrap-admin
pnpm exec tsx packages/enterprise/src/entry.ts
```

Set `ZCODE_ENTERPRISE_DATA_ROOT`, `ZCODE_ENTERPRISE_DB_PATH`, `ZCODE_ENTERPRISE_WORKSPACE_ROOT`, `ZCODE_ENTERPRISE_STATIC_ROOT`, `ZCODE_ENTERPRISE_PORT`, and `ZCODE_ENTERPRISE_ORIGIN` as needed. The workspace root contains Customer workspaces. The gateway binds `127.0.0.1:3031` by default. Container mode requires `ZCODE_ENTERPRISE_RELAY_ORIGIN` or `ZCODE_ENTERPRISE_ORIGIN` to name an HTTP(S) origin reachable from Customer runtimes for the MCP relay; loopback origins are rejected at startup. For production, use the same public HTTPS origin served by the TLS reverse proxy, which can continue forwarding to the loopback gateway. For local Docker testing without a reverse proxy, use `ZCODE_ENTERPRISE_RELAY_ORIGIN=http://host.docker.internal:3031` and bind the gateway to a host interface reachable by Docker with `ZCODE_ENTERPRISE_HOST=0.0.0.0`; restrict that listener with the host firewall. The container maps `host.docker.internal` on Linux and uses Docker Desktop's host mapping on macOS. The MCP relay accepts only random per-Customer, per-binding tokens and forwards to that binding's stored endpoint; it is not an arbitrary URL proxy. Do not expose the native runtime ports.
Keep any custom data root and database outside the Docker build context. The default `.enterprise-data` is excluded by `.dockerignore`.

The default `container` adapter launches one unprivileged Docker container per Customer runtime. Multiple native sessions for the same Customer share that workspace, runtime data volume, task index, Skills, MCP bindings, and distributed model provider. The runtime image builds the native ZCode server and CLI agent. Container port 3030 is published to a random loopback port. `ZCODE_ENTERPRISE_RUNTIME_IMAGE` chooses the image. On macOS, allow Docker Desktop access to the Customer workspace root. `ZCODE_ENTERPRISE_RUNTIME_MODE=process` is available for local development only; it does not isolate host files or shell operations.

Each enterprise runtime adapter injects `ZCODE_ENTERPRISE_MANAGED_MODEL=1` into the native server. The native server uses that marker to keep tenant model configuration and runtime storage as the sole responsibility of the enterprise control plane: provider configuration writes, Z.ai OAuth mutations, OAuth session restoration, database-root changes, and generic credential read/write RPCs are rejected or return a signed-out result; rejected calls use `enterprise.model_configuration_managed`. Provider status/model reads and ordinary settings such as locale remain available. A normal ZCode Web, remote workspace, or Desktop continuous server started without this marker keeps its existing behavior.

## Model provider distribution

When a Customer runtime is prepared, the gateway writes the tenant's custom provider credential into that Customer's native provider configuration (`.zcode/v2/provider_config.json` under the runtime data volume) as the managed `enterprise-custom` slot: the runtime receives the real upstream base URL and real API key and connects to the provider directly through the native provider stack. There is no model relay on the request path, so ordinary developer environments (transparent proxies, fake-IP DNS) behave exactly like native ZCode. The distributed credential lives only inside that Customer's isolated container volume; members cannot change it (`ZCODE_ENTERPRISE_MANAGED_MODEL`) and the settings UI hides the native provider editor. Revoking the tenant credential re-provisions the managed slot away on the next runtime start.

Configure `ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON` before adding MCP bindings. It maps each tenant UUID to allowed HTTPS origins or exact endpoints, for example `{"tenant-uuid":["https://knowledge.example.com"]}`. Missing or malformed entries deny the binding. DNS results must all be public addresses; the relay connects to a validated address while retaining the hostname for TLS. `secretRef` must name an environment variable with the tenant's compact uppercase UUID: `ZCODE_ENTERPRISE_MCP_SECRET_<TENANT_UUID_WITHOUT_HYPHENS>_<NAME>`. The gateway resolves it in the gateway process and injects it only when relaying requests to the stored upstream endpoint. A Customer workspace receives a scoped, revocable relay token and URL; it never receives the upstream secret. If a reference is missing, that binding is skipped and reported as a gateway warning. Keep the workspace root and gateway data readable only by trusted operators.

## Tenant model credentials

`EnterpriseStore` is the sole owner of tenant model credentials. A credential is
keyed by `(tenant_id, provider_family)` and is stored in the SQLite
`model_credentials` table as an AES-256-GCM ciphertext, nonce and authentication
tag. The encryption key is a required 32-byte constructor value. The enterprise
entry resolves `ZCODE_ENTERPRISE_MODEL_CREDENTIALS_KEY` first (base64,
`base64:` or `hex:` encoded), then uses a generated 0600 local
`model-credentials.key` under the configured data root when no environment
value is supplied. The resolved key is passed to the store and is never
persisted in SQLite, any browser state, or gateway logs; inside a Customer runtime it exists only as the distributed provider configuration.

The admin-only store commands are `upsertModelCredential`,
`rotateModelCredential`, and `revokeModelCredential`. They verify current
tenant membership and the `admin` role before writing. Rotation replaces the
encrypted value atomically. Revocation clears the encrypted value and leaves a
revoked status row so the gateway can invalidate an existing tenant binding.

`listModelCredentialStatuses` is the only status projection. It returns the
provider family, configured/revoked state, update time and at most the final
four characters of an active key. It never returns ciphertext, nonce, auth tag
or the API key. `getModelCredentialForGateway` is an internal gateway read and
returns a decrypted key only for an active row; browser-facing handlers must
not expose this method or its result. Decryption is bound to the tenant and
provider family as additional authenticated data, so moving a row between
tenants or provider families fails closed.

The migration from schema version 1 to version 2 creates
`model_credentials` transactionally. Missing or malformed encryption key
configuration fails credential commands with a generic validation error; API
keys are never included in errors or logs. Acceptance requires tenant
isolation, ciphertext-at-rest checks, rotation, revocation, wrong-key/tamper
failure, and a migration check.
