# Connecting MCP servers to opencode

[MCP](https://modelcontextprotocol.io) (Model Context Protocol) is an open standard that lets a coding agent talk to external tools — GitHub, databases, browsers, files, your own APIs — through small "MCP servers". opencode (and therefore this Slack bot) can use any of them.

Because the bot runs the **same local opencode** as your terminal, **any MCP server you configure for opencode is automatically available to the Slack bot too** — no extra setup in the bot itself.

---

## 1. Where the config lives

opencode reads MCP servers (and everything else) from `opencode.json`, checked in this order and deep-merged (project overrides global):

| Scope | File |
|---|---|
| Global (all projects) | `~/.config/opencode/opencode.json` |
| Per-project | `./opencode.json`, `./opencode.jsonc`, or `.opencode/opencode.json` |

The bot starts opencode with your working directory as the project root, so a `opencode.json` at the root of whatever folder you're working in applies too.

> ⚠️ Config is read once at startup. **After editing `opencode.json`, restart the bot** from the dashboard (or `launchctl kickstart -k gui/$(id -u)/com.opencode.slack.dashboard`) for it to take effect.

---

## 2. Adding servers — `mcp` key

Add an `mcp` object to `opencode.json`. Each entry is keyed by a server name and must have a `type`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "playwright": {
      "type": "local",
      "command": ["npx", "-y", "@playwright/mcp"],
      "enabled": true,
      "environment": { "BROWSER": "chromium" }
    },
    "github": {
      "type": "remote",
      "url": "https://your-mcp-server.example.com/mcp",
      "headers": { "Authorization": "Bearer {env:GITHUB_TOKEN}" }
    }
  }
}
```

### Local servers (run as a child process)

- `"type": "local"` — required.
- `"command"` — **an array of strings** (the process + arguments), e.g. `["npx", "-y", "@playwright/mcp"]` or `["node", "./server.js"]`. Not a single string.
- `"environment"` — optional env vars passed to the server process.
- `"enabled"` — optional (`true`/`false`).

### Remote servers (HTTPS endpoint)

- `"type": "remote"` — required.
- `"url"` — the MCP endpoint.
- `"headers"` — optional headers, commonly `Authorization`.
- `"enabled"` — optional.

### Secrets in config

Header/other string values support `{env:VAR}` interpolation — the value is pulled from your environment at startup, so you can keep tokens out of the file:

```json
"headers": { "Authorization": "Bearer {env:MY_TOKEN}" }
```

(`{file:path}` works too. Shell-style `${VAR}` is **not** substituted.)

### Disabling a server

You can disable a server inherited from another config (e.g. one defined globally) without deleting it:

```json
{
  "mcp": {
    "old-server": { "enabled": false }
  }
}
```

---

## 3. Common examples

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "filesystem": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/Users/YOU/projects"]
    },
    "sequential-thinking": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-sequential-thinking"]
    }
  }
}
```

## 4. Tools show up as `mcp__<server>__<tool>`

Once a server is loaded, its tools are available to the agent under the namespaced form **`mcp__<server-name>__<tool-name>`** (e.g. `mcp__github__create_issue`). In the Slack thread's ⚙️ Commands card you'll see those tools run like any other. The bot's log channel (`LOG_CHANNEL`) also reports `🧰 Tool: mcp__<server>__<tool>` events.

---

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| Tools not appearing after editing config | Restart the bot — config is read only at startup. |
| `mcp__...` tools never run in a session | Open the folder containing your `opencode.json` as the working directory, or move the `mcp` block to `~/.config/opencode/opencode.json`. |
| Local server fails to spawn | Double-check `command` is an **array**, the binary is installed, and the working dir has access. Look in the dashboard logs. |
| Auth headers not sent | Use `{env:VAR}` in the header value and make sure the env var is set **before** the bot starts. |
| A shared/global server you don't want | `{ "mcp": { "<name>": { "enabled": false } } }`. |
