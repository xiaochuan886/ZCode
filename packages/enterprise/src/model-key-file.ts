import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Local installations persist the wrapping key separately from the SQLite database. */
export async function loadModelCredentialEncryptionKey(dataRoot: string): Promise<string> {
  const configured = process.env["ZCODE_ENTERPRISE_MODEL_CREDENTIALS_KEY"]?.trim();
  if (configured) return configured;
  const file = join(dataRoot, "model-credentials.key");
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  try {
    return (await readFile(file, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const generated = randomBytes(32).toString("hex");
  try {
    await writeFile(file, `${generated}\n`, { mode: 0o600, flag: "wx" });
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return (await readFile(file, "utf8")).trim();
    throw error;
  }
}
