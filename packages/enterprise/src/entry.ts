import { resolve } from "node:path";
import { EnterpriseStore } from "./store.js";
import { EnterpriseAuth } from "./auth.js";
import { ContainerRuntimeAdapter, ProcessRuntimeAdapter, RuntimeManager } from "./runtime.js";
import { createEnterpriseGateway } from "./gateway.js";

const root = resolve(process.cwd());
const dataRoot = resolve(process.env["ZCODE_ENTERPRISE_DATA_ROOT"] ?? "./.enterprise-data");
const workspaceRoot = resolve(
  process.env["ZCODE_ENTERPRISE_WORKSPACE_ROOT"] ?? `${dataRoot}/cases`,
);
const dbPath = resolve(process.env["ZCODE_ENTERPRISE_DB_PATH"] ?? `${dataRoot}/enterprise.sqlite`);
const staticRoot = resolve(process.env["ZCODE_ENTERPRISE_STATIC_ROOT"] ?? "./packages/web/dist");
const mode = process.env["ZCODE_ENTERPRISE_RUNTIME_MODE"] ?? "container";
const host = process.env["ZCODE_ENTERPRISE_HOST"] ?? "127.0.0.1";
const expectedOrigin = process.env["ZCODE_ENTERPRISE_ORIGIN"];
const configuredRelayOrigin = process.env["ZCODE_ENTERPRISE_RELAY_ORIGIN"] ?? expectedOrigin;

async function main() {
  if (mode !== "container" && mode !== "process")
    throw new Error("Unsupported enterprise runtime mode");
  if (mode === "container" && !configuredRelayOrigin) {
    throw new Error(
      "Container runtime requires ZCODE_ENTERPRISE_RELAY_ORIGIN or ZCODE_ENTERPRISE_ORIGIN that Case containers can reach",
    );
  }
  if (mode === "container" && configuredRelayOrigin) {
    const relay = new URL(configuredRelayOrigin);
    if (
      (relay.protocol !== "http:" && relay.protocol !== "https:") ||
      relay.username ||
      relay.password ||
      relay.pathname !== "/" ||
      relay.search ||
      relay.hash
    ) {
      throw new Error(
        "Enterprise relay origin must be an HTTP(S) origin without credentials, path, query or fragment",
      );
    }
    if (["127.0.0.1", "localhost", "::1"].includes(relay.hostname)) {
      throw new Error(
        "Container runtime cannot reach a loopback relay origin; use a reachable enterprise origin",
      );
    }
    if (
      relay.hostname === "host.docker.internal" &&
      ["127.0.0.1", "localhost", "::1"].includes(host)
    ) {
      throw new Error(
        "A host.docker.internal relay requires ZCODE_ENTERPRISE_HOST=0.0.0.0 or a reachable host interface",
      );
    }
  }
  const store = await EnterpriseStore.open(dbPath, workspaceRoot);
  const adapter =
    mode === "container"
      ? new ContainerRuntimeAdapter({
          image: process.env["ZCODE_ENTERPRISE_RUNTIME_IMAGE"] ?? "zcode-enterprise-runtime:local",
          dataRoot: `${dataRoot}/runtimes`,
        })
      : new ProcessRuntimeAdapter({
          serverEntry:
            process.env["ZCODE_ENTERPRISE_SERVER_ENTRY"] ??
            `${root}/packages/server/dist/entry-http.js`,
          dataRoot: `${dataRoot}/runtimes`,
        });
  const gateway = createEnterpriseGateway({
    store,
    auth: new EnterpriseAuth(store),
    runtimes: new RuntimeManager(adapter),
    staticRoot,
    host,
    port: Number(process.env["ZCODE_ENTERPRISE_PORT"] ?? 3031),
    ...(expectedOrigin ? { expectedOrigin } : {}),
    ...(configuredRelayOrigin ? { relayOrigin: configuredRelayOrigin } : {}),
  });
  await gateway.listen();
  const shutdown = async () => {
    await gateway.close();
    store.close();
  };
  process.once("SIGTERM", () => {
    void shutdown();
  });
  process.once("SIGINT", () => {
    void shutdown();
  });
}

void main().catch((error: unknown) => {
  console.error("Enterprise gateway startup failed", error);
  process.exitCode = 1;
});
