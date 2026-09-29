# Enterprise gateway

This opt-in gateway serves the built Web client and routes an authenticated active Case to one private native ZCode server. It does not change ordinary desktop or Web entry points.

From the repository root, use Node 24 and build the native server and Web client:

```sh
pnpm install --frozen-lockfile
pnpm --filter @zcode/server build
pnpm --filter @zcode/web build
docker build -f packages/enterprise/Dockerfile.runtime -t zcode-enterprise-runtime:local .
RUN_ENTERPRISE_DOCKER_E2E=1 pnpm --filter @zcode/enterprise test:e2e
pnpm --filter @zcode/enterprise bootstrap-admin
pnpm exec tsx packages/enterprise/src/entry.ts
```

Set `ZCODE_ENTERPRISE_DATA_ROOT`, `ZCODE_ENTERPRISE_DB_PATH`, `ZCODE_ENTERPRISE_WORKSPACE_ROOT`, `ZCODE_ENTERPRISE_STATIC_ROOT`, `ZCODE_ENTERPRISE_PORT`, and `ZCODE_ENTERPRISE_ORIGIN` as needed. The gateway binds `127.0.0.1:3031` by default. Container mode requires `ZCODE_ENTERPRISE_RELAY_ORIGIN` or `ZCODE_ENTERPRISE_ORIGIN` to name an HTTP(S) origin reachable from Case containers; loopback origins are rejected at startup. For production, use the same public HTTPS origin served by the TLS reverse proxy, which can continue forwarding to the loopback gateway. For local Docker testing without a reverse proxy, use `ZCODE_ENTERPRISE_RELAY_ORIGIN=http://host.docker.internal:3031` and bind the gateway to a host interface reachable by Docker with `ZCODE_ENTERPRISE_HOST=0.0.0.0`; restrict that listener with the host firewall. The container maps `host.docker.internal` on Linux and uses Docker Desktop's host mapping on macOS. The MCP relay accepts only random per-Case, per-binding tokens and forwards to that binding's stored endpoint; it is not an arbitrary URL proxy. Do not expose the native runtime ports.
Keep any custom data root and database outside the Docker build context. The default `.enterprise-data` is excluded by `.dockerignore`.

The default `container` adapter launches one unprivileged Docker container per Case. Each receives only its Case workspace and private runtime data volume. Container port 3030 is published to a random loopback port. `ZCODE_ENTERPRISE_RUNTIME_IMAGE` chooses the image. On macOS, allow Docker Desktop access to the Case workspace root. `ZCODE_ENTERPRISE_RUNTIME_MODE=process` is available for local development only; it does not isolate host files or shell operations.

MCP binding `secretRef` must name an environment variable beginning with `ZCODE_ENTERPRISE_MCP_SECRET_`. The gateway resolves it in the gateway process and injects it only when relaying requests to the stored upstream endpoint. A Case workspace receives a scoped, revocable relay token and URL; it never receives the upstream secret. If a reference is missing, that binding is skipped and reported as a gateway warning. Keep the workspace root and gateway data readable only by trusted operators.
