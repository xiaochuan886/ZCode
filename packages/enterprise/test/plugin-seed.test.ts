import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { seedBaselinePlugins } from "../src/plugin-seed.js";

const MARKER_NAME = ".enterprise-seed.json";
const storageRoot = (home: string) => join(home, ".zcode", "cli", "plugins");
const cacheRoot = (home: string) => join(storageRoot(home), "cache", "zcode-plugins-official");
const configPath = (home: string) => join(home, ".zcode", "cli", "config.json");
const registryPath = (home: string) => join(storageRoot(home), "installed_plugins.json");
const markerPath = (home: string, name: string, version: string) =>
  join(cacheRoot(home), name, version, MARKER_NAME);

async function makePlugin(
  root: string,
  name: string,
  version: string,
  content: string,
): Promise<void> {
  await mkdir(join(root, name, version), { recursive: true });
  await writeFile(join(root, name, version, "plugin.json"), content);
}

async function enabledEntries(home: string): Promise<Record<string, unknown>> {
  const config = JSON.parse(await readFile(configPath(home), "utf8")) as {
    plugins: { enabledPlugins: Record<string, unknown> };
  };
  return config.plugins.enabledPlugins;
}

interface RegistryRecord {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  installPath: string;
  installedAt: string;
  scope: string;
  [key: string]: unknown;
}

async function registryRecords(home: string): Promise<RegistryRecord[]> {
  const state = JSON.parse(await readFile(registryPath(home), "utf8")) as {
    version: number;
    plugins: RegistryRecord[];
  };
  return state.plugins;
}

test("baseline plugins seed into the expert plugin cache and are enabled in config.json", async () => {
  const seedRoot = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-root-"));
  const home = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-"));
  await makePlugin(seedRoot, "superpowers", "0.5.1", "superpowers v1\n");
  await makePlugin(seedRoot, "zcode-guide", "0.3.0", "zcode-guide v1\n");
  const seeded = await seedBaselinePlugins(home, seedRoot);
  assert.deepEqual(seeded, ["superpowers/0.5.1", "zcode-guide/0.3.0"]);
  assert.equal(
    await readFile(join(cacheRoot(home), "superpowers", "0.5.1", "plugin.json"), "utf8"),
    "superpowers v1\n",
  );
  // 每个种子单元写入标记:version 是种子时捆绑目录的内容摘要。
  const marker = JSON.parse(await readFile(markerPath(home, "superpowers", "0.5.1"), "utf8")) as {
    version: unknown;
    seededAt: unknown;
  };
  assert.match(String(marker.version), /^[0-9a-f]{64}$/);
  assert.equal(typeof marker.seededAt, "string");
  assert.deepEqual(await enabledEntries(home), {
    "superpowers@zcode-plugins-official": true,
    "zcode-guide@zcode-plugins-official": true,
  });
  // 发现链路的第二道门槛:安装记录写入 installed_plugins.json,installPath
  // 留空让解析回退到我们种子的缓存目录,不内嵌绝对 HOME 路径。
  const records = await registryRecords(home);
  assert.deepEqual(
    records.map((record) => record.id),
    ["superpowers@zcode-plugins-official", "zcode-guide@zcode-plugins-official"],
  );
  assert.deepEqual(
    records.map(({ installPath, installedAt, ...rest }) => ({
      ...rest,
      installPath,
      installedAtType: typeof installedAt,
    })),
    [
      {
        id: "superpowers@zcode-plugins-official",
        name: "superpowers",
        marketplace: "zcode-plugins-official",
        version: "0.5.1",
        scope: "user",
        installPath: "",
        installedAtType: "string",
      },
      {
        id: "zcode-guide@zcode-plugins-official",
        name: "zcode-guide",
        marketplace: "zcode-plugins-official",
        version: "0.3.0",
        scope: "user",
        installPath: "",
        installedAtType: "string",
      },
    ],
  );
});

test("an unchanged seed root rewrites nothing on the second preparation", async () => {
  const seedRoot = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-idempotent-root-"));
  const home = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-idempotent-"));
  await makePlugin(seedRoot, "alpha", "1.0.0", "alpha v1\n");
  assert.deepEqual(await seedBaselinePlugins(home, seedRoot), ["alpha/1.0.0"]);
  const content = join(cacheRoot(home), "alpha", "1.0.0", "plugin.json");
  const before = await stat(content);
  const markerBefore = await readFile(markerPath(home, "alpha", "1.0.0"), "utf8");
  const configBefore = await readFile(configPath(home), "utf8");
  const registryBefore = await readFile(registryPath(home), "utf8");
  const second = await seedBaselinePlugins(home, seedRoot);
  assert.deepEqual(second, []);
  // 重写必然更新 mtime、marker 的 seededAt、config 或注册表字节;未变即证明零写入。
  assert.equal((await stat(content)).mtimeMs, before.mtimeMs);
  assert.equal(await readFile(markerPath(home, "alpha", "1.0.0"), "utf8"), markerBefore);
  assert.equal(await readFile(configPath(home), "utf8"), configBefore);
  assert.equal(await readFile(registryPath(home), "utf8"), registryBefore);
});

test("a seed-root upgrade refreshes pristine copies and leaves diverged or personal ones alone", async () => {
  const seedRoot = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-upgrade-root-"));
  const home = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-upgrade-"));
  await makePlugin(seedRoot, "alpha", "1.0.0", "alpha v1\n");
  await makePlugin(seedRoot, "beta", "1.0.0", "beta v1\n");
  await makePlugin(seedRoot, "delta", "1.0.0", "delta v1\n");
  // 个人插件目录在种子前已存在且无标记:始终维持 if-missing 语义。
  await mkdir(join(cacheRoot(home), "personal", "9.9.9"), { recursive: true });
  await writeFile(join(cacheRoot(home), "personal", "9.9.9", "plugin.json"), "personal\n");

  const first = await seedBaselinePlugins(home, seedRoot);
  assert.deepEqual(first, ["alpha/1.0.0", "beta/1.0.0", "delta/1.0.0"]);
  const alphaMarkerV1 = await readFile(markerPath(home, "alpha", "1.0.0"), "utf8");
  const betaMarkerV1 = JSON.parse(await readFile(markerPath(home, "beta", "1.0.0"), "utf8")) as {
    version: string;
  };

  // 专家在 alpha 副本上做了修改;种子根升级(beta 换版本、gamma 新增、
  // delta 旧版本移除且新版本加入——移除从不删除既有副本)。
  await writeFile(
    join(cacheRoot(home), "alpha", "1.0.0", "plugin.json"),
    "alpha v1\nexpert tweak\n",
  );
  await makePlugin(seedRoot, "beta", "1.0.0", "beta v2\n");
  await makePlugin(seedRoot, "gamma", "1.0.0", "gamma v1\n");
  await makePlugin(seedRoot, "delta", "2.0.0", "delta v2\n");
  await rm(join(seedRoot, "delta", "1.0.0"), { recursive: true, force: true });

  const second = await seedBaselinePlugins(home, seedRoot);
  // beta 干净副本被刷新;alpha 已被专家改动,personal 是个人目录,两者都不动。
  assert.deepEqual(second, ["beta/1.0.0", "delta/2.0.0", "gamma/1.0.0"]);
  assert.equal(
    await readFile(join(cacheRoot(home), "beta", "1.0.0", "plugin.json"), "utf8"),
    "beta v2\n",
  );
  const betaMarkerV2 = JSON.parse(await readFile(markerPath(home, "beta", "1.0.0"), "utf8")) as {
    version: string;
  };
  assert.notEqual(betaMarkerV2.version, betaMarkerV1.version);
  const deltaInstalledAtV1 = (await registryRecords(home)).find(
    (record) => record.id === "delta@zcode-plugins-official",
  )!.installedAt;
  assert.equal(
    await readFile(join(cacheRoot(home), "alpha", "1.0.0", "plugin.json"), "utf8"),
    "alpha v1\nexpert tweak\n",
  );
  assert.equal(await readFile(markerPath(home, "alpha", "1.0.0"), "utf8"), alphaMarkerV1);
  assert.equal(
    await readFile(join(cacheRoot(home), "personal", "9.9.9", "plugin.json"), "utf8"),
    "personal\n",
  );
  await assert.rejects(readFile(markerPath(home, "personal", "9.9.9")));
  // 从种子根删除的旧版本仍在缓存里(种子绝不移除),新版本并存。
  assert.equal(
    await readFile(join(cacheRoot(home), "delta", "1.0.0", "plugin.json"), "utf8"),
    "delta v1\n",
  );
  assert.equal(
    await readFile(join(cacheRoot(home), "delta", "2.0.0", "plugin.json"), "utf8"),
    "delta v2\n",
  );
  // 启用条目覆盖种子根当前的插件名(含新名字,不含已整体移除的名字)。
  assert.deepEqual(await enabledEntries(home), {
    "alpha@zcode-plugins-official": true,
    "beta@zcode-plugins-official": true,
    "delta@zcode-plugins-official": true,
    "gamma@zcode-plugins-official": true,
  });
  // 安装注册表按 id upsert:delta 记录换成新版本,installedAt 保持首次种子时间,
  // gamma 作为新记录追加;不存在移除。
  const upgradedRecords = await registryRecords(home);
  assert.deepEqual(
    upgradedRecords.map((record) => [record.id, record.version]),
    [
      ["alpha@zcode-plugins-official", "1.0.0"],
      ["beta@zcode-plugins-official", "1.0.0"],
      ["delta@zcode-plugins-official", "2.0.0"],
      ["gamma@zcode-plugins-official", "1.0.0"],
    ],
  );
  assert.equal(upgradedRecords[2]!.installedAt, deltaInstalledAtV1);

  // 刷新后再次运行:全部跳过,零写入。
  assert.deepEqual(await seedBaselinePlugins(home, seedRoot), []);
});

test("the config.json merge preserves native state and creates the nested enabled map", async () => {
  const seedRoot = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-merge-root-"));
  const home = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-merge-"));
  await makePlugin(seedRoot, "superpowers", "0.5.1", "superpowers v1\n");
  // 预置原生 CLI 状态:无关键与既有启用项都必须原样保留。
  await mkdir(join(home, ".zcode", "cli"), { recursive: true });
  await writeFile(
    configPath(home),
    `${JSON.stringify({
      theme: "dark",
      plugins: { autoUpdate: false, enabledPlugins: { "other@zcode-plugins-official": true } },
    })}\n`,
  );
  await seedBaselinePlugins(home, seedRoot);
  const merged = JSON.parse(await readFile(configPath(home), "utf8")) as {
    theme: string;
    plugins: { autoUpdate: boolean; enabledPlugins: Record<string, unknown> };
  };
  assert.equal(merged.theme, "dark");
  assert.equal(merged.plugins.autoUpdate, false);
  assert.equal(merged.plugins.enabledPlugins["other@zcode-plugins-official"], true);
  assert.equal(merged.plugins.enabledPlugins["superpowers@zcode-plugins-official"], true);

  // 嵌套 plugins.enabledPlugins 整体缺失时被创建,无关顶层键仍在。
  const bareHome = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-merge-bare-"));
  await mkdir(join(bareHome, ".zcode", "cli"), { recursive: true });
  await writeFile(configPath(bareHome), `${JSON.stringify({ theme: "light" })}\n`);
  await seedBaselinePlugins(bareHome, seedRoot);
  const bare = JSON.parse(await readFile(configPath(bareHome), "utf8")) as {
    theme: string;
    plugins: { enabledPlugins: Record<string, unknown> };
  };
  assert.equal(bare.theme, "light");
  assert.equal(bare.plugins.enabledPlugins["superpowers@zcode-plugins-official"], true);
});

test("a disabled seeded plugin is re-enabled by the next preparation", async () => {
  const seedRoot = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-reenable-root-"));
  const home = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-reenable-"));
  await makePlugin(seedRoot, "superpowers", "0.5.1", "superpowers v1\n");
  await seedBaselinePlugins(home, seedRoot);
  const config = JSON.parse(await readFile(configPath(home), "utf8")) as {
    plugins: { enabledPlugins: Record<string, boolean> };
  };
  // 专家在会话中禁用了种子插件:下次 prepare 会重新启用——基线集是托管内容。
  config.plugins.enabledPlugins["superpowers@zcode-plugins-official"] = false;
  await writeFile(configPath(home), `${JSON.stringify(config)}\n`);
  await seedBaselinePlugins(home, seedRoot);
  assert.equal((await enabledEntries(home))["superpowers@zcode-plugins-official"], true);
});

test("an unchanged config.json is not rewritten, not even for formatting", async () => {
  const seedRoot = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-nowrite-root-"));
  const home = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-nowrite-"));
  await makePlugin(seedRoot, "superpowers", "0.5.1", "superpowers v1\n");
  await mkdir(join(home, ".zcode", "cli"), { recursive: true });
  // CLI 自己写入的紧凑格式 + 乱序键:逻辑内容已满足合并结果时必须原样保留。
  const compact =
    '{"plugins":{"enabledPlugins":{"superpowers@zcode-plugins-official":true}},"theme":"dark"}';
  await writeFile(configPath(home), compact);
  await seedBaselinePlugins(home, seedRoot);
  assert.equal(await readFile(configPath(home), "utf8"), compact);
});

test("the install registry merge preserves foreign records and upserts by id", async () => {
  const seedRoot = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-registry-root-"));
  const home = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-registry-"));
  await makePlugin(seedRoot, "superpowers", "0.5.1", "superpowers v1\n");
  // 预置原生注册表:外来记录(自定义 installPath 与额外字段)必须原样保留;
  // 旧版本 superpowers 记录按 id upsert,installedAt 与非托管字段不重置。
  await mkdir(storageRoot(home), { recursive: true });
  const foreignRecord = {
    id: "other-market@foreign-market",
    name: "other-market",
    marketplace: "foreign-market",
    version: "3.2.1",
    installPath: "/opt/foreign-plugins/other-market",
    installedAt: "2020-01-01T00:00:00.000Z",
    scope: "workspace",
    dependencies: ["dep-a@foreign-market"],
    source: { kind: "git", url: "https://foreign.example.test/other-market.git" },
  };
  const staleRecord = {
    id: "superpowers@zcode-plugins-official",
    name: "superpowers",
    marketplace: "zcode-plugins-official",
    version: "0.1.0",
    installPath: "",
    installedAt: "2021-06-01T00:00:00.000Z",
    updatedAt: "2021-06-01T00:00:00.000Z",
    scope: "user",
    source: { kind: "marketplace" },
  };
  await writeFile(
    registryPath(home),
    `${JSON.stringify({ version: 1, plugins: [foreignRecord, staleRecord] })}\n`,
  );
  await seedBaselinePlugins(home, seedRoot);
  const records = await registryRecords(home);
  assert.deepEqual(records[0], foreignRecord);
  const upserted = records[1]!;
  assert.equal(upserted.version, "0.5.1");
  assert.equal(upserted.installPath, "");
  assert.equal(upserted.scope, "user");
  assert.equal(upserted.installedAt, "2021-06-01T00:00:00.000Z");
  // 非托管字段(dependencies/source/updatedAt)不被网关重置。
  assert.deepEqual(upserted.source, { kind: "marketplace" });
  assert.equal(upserted.updatedAt, "2021-06-01T00:00:00.000Z");
});

test("an invalid install registry is left untouched with a warning while config still merges", async (t) => {
  const seedRoot = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-reg-invalid-root-"));
  await makePlugin(seedRoot, "superpowers", "0.5.1", "superpowers v1\n");
  const warning = t.mock.method(process, "emitWarning");
  try {
    const home = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-reg-invalid-"));
    await mkdir(storageRoot(home), { recursive: true });
    await writeFile(registryPath(home), "not json {");
    await seedBaselinePlugins(home, seedRoot);
    // 非法注册表绝不破坏,插件缓存与 config 合并照常完成。
    assert.equal(await readFile(registryPath(home), "utf8"), "not json {");
    assert.equal((await enabledEntries(home))["superpowers@zcode-plugins-official"], true);
    assert.equal(
      await readFile(join(cacheRoot(home), "superpowers", "0.5.1", "plugin.json"), "utf8"),
      "superpowers v1\n",
    );

    // 合法 JSON 但 plugins 不是数组:同样跳过写入。
    const mapHome = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-reg-invalid-map-"));
    await mkdir(storageRoot(mapHome), { recursive: true });
    const mapForm = '{"version":1,"plugins":{"superpowers@zcode-plugins-official":{}}}';
    await writeFile(registryPath(mapHome), mapForm);
    await seedBaselinePlugins(mapHome, seedRoot);
    assert.equal(await readFile(registryPath(mapHome), "utf8"), mapForm);
    const codes = warning.mock.calls.map(
      (call) => (call.arguments[1] as { code?: string } | undefined)?.code,
    );
    assert.equal(
      codes.filter((code) => code === "ZCODE_ENTERPRISE_PLUGIN_INSTALL_INVALID").length,
      2,
    );
  } finally {
    warning.mock.restore();
  }
});

test("an invalid config.json is left untouched with a warning and the tree still seeds", async (t) => {
  const seedRoot = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-invalid-root-"));
  await makePlugin(seedRoot, "superpowers", "0.5.1", "superpowers v1\n");
  const warning = t.mock.method(process, "emitWarning");
  try {
    const home = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-invalid-"));
    await mkdir(join(home, ".zcode", "cli"), { recursive: true });
    await writeFile(configPath(home), "not json {");
    await seedBaselinePlugins(home, seedRoot);
    // 非法文件绝不能被破坏:字节保持原样,插件缓存照常种子。
    assert.equal(await readFile(configPath(home), "utf8"), "not json {");
    assert.equal(
      await readFile(join(cacheRoot(home), "superpowers", "0.5.1", "plugin.json"), "utf8"),
      "superpowers v1\n",
    );

    // 合法 JSON 但不是对象:同样跳过写入。
    const arrayHome = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-invalid-array-"));
    await mkdir(join(arrayHome, ".zcode", "cli"), { recursive: true });
    await writeFile(configPath(arrayHome), "[]");
    await seedBaselinePlugins(arrayHome, seedRoot);
    assert.equal(await readFile(configPath(arrayHome), "utf8"), "[]");
    const codes = warning.mock.calls.map(
      (call) => (call.arguments[1] as { code?: string } | undefined)?.code,
    );
    assert.equal(
      codes.filter((code) => code === "ZCODE_ENTERPRISE_PLUGIN_CONFIG_INVALID").length,
      2,
    );
  } finally {
    warning.mock.restore();
  }
});

test("an unset or missing seed root is a no-op", async () => {
  const home = await mkdtemp(join(tmpdir(), "enterprise-plugin-seed-missing-"));
  assert.deepEqual(await seedBaselinePlugins(home, undefined), []);
  assert.deepEqual(await seedBaselinePlugins(home, join(home, "no-such-root")), []);
  // 根缺失时不产生任何插件缓存,也不创建 CLI config 或安装注册表。
  await assert.rejects(readFile(configPath(home)));
  await assert.rejects(readFile(registryPath(home)));
  await assert.rejects(readFile(join(cacheRoot(home), "superpowers", "0.5.1", "plugin.json")));
});
