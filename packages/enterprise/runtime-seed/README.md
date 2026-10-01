# Runtime seed

Baseline content seeded into every expert runtime's HOME `~/.agents/skills/` at
runtime preparation. Each seeded directory carries a `.enterprise-seed.json`
marker recording the SHA-256 digest of the bundled skill directory at seed
time (the marker itself is excluded from the digest).

Sources are the official ZCode plugins (cache layout
`~/.zcode/cli/plugins/cache/zcode-plugins-official/<plugin>/<version>/skills/`):

| Skill directory                | Source plugin / version |
| ------------------------------ | ----------------------- |
| `skill-creator`                | skill-creator 0.1.0     |
| `diagnosing-*`, `zcode-configuration-guide` | zcode-guide 0.1.0 |
| `docx`                         | documents 0.1.7         |
| `pdf`                          | pdf 0.1.7               |
| `pptx`                         | presentations 0.1.7     |
| `xlsx`                         | spreadsheets 0.1.7      |

Upgrading a baseline skill: copy the new version over its directory here. At
the next runtime preparation every seeded copy whose content still matches its
recorded digest (a pristine copy) is replaced with the new bundled version.
Modified copies are never overwritten: a directory that has diverged from its
marker digest (expert edits) and personal directories without a marker keep
the if-missing guarantee and stay untouched.
Full plugin seeding (commands, plugin MCP, marketplace metadata) is deferred
until the plugin system's offline behavior inside the container is verified.
