# Runtime seed

Baseline content seeded into every expert runtime's HOME `~/.agents/skills/` at
runtime preparation (if-missing only; never overwrites existing directories).

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

Upgrading a baseline skill: copy the new version over its directory here; already
seeded expert HOMEs keep the old copy until the directory is deleted there
(seeding is if-missing by design — personal territory is never overwritten).
Full plugin seeding (commands, plugin MCP, marketplace metadata) is deferred
until the plugin system's offline behavior inside the container is verified.
