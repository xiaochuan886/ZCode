import { stdin, stdout } from "node:process";
import { EnterpriseAuth } from "./auth.js";
import { EnterpriseStore } from "./store.js";

async function readPassword(): Promise<string> {
  if (!stdin.isTTY) {
    let value = "";
    for await (const chunk of stdin) value += String(chunk);
    return value.replace(/\r?\n$/, "");
  }
  stdout.write("Initial admin password: ");
  stdin.setRawMode(true);
  stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      const onData = (chunk: Buffer) => {
        for (const char of chunk.toString("utf8")) {
          if (char === "\r" || char === "\n") {
            stdin.off("data", onData);
            stdout.write("\n");
            resolve(value);
            return;
          }
          if (char === "\u0003") {
            stdin.off("data", onData);
            reject(new Error("Interrupted"));
            return;
          }
          if (char === "\u007f") value = value.slice(0, -1);
          else value += char;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

const [dbPath, workspaceRoot, tenantName, email, displayName] = process.argv.slice(2);
if (!dbPath || !workspaceRoot || !tenantName || !email) {
  process.stderr.write(
    "Usage: bootstrap-admin <db-path> <workspace-root> <tenant-name> <email> [display-name]\n",
  );
  process.exitCode = 2;
} else {
  const store = await EnterpriseStore.open(dbPath, workspaceRoot);
  try {
    const passwordHash = await EnterpriseAuth.hashPassword(await readPassword());
    const result = store.bootstrapAdmin(tenantName, email, passwordHash, displayName);
    stdout.write(`Created tenant ${result.tenant.id} and admin ${result.user.id}\n`);
  } finally {
    store.close();
  }
}
